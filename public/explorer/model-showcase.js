import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";

export function attachModelShowcase(record, source, appearance = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "catalog-aniimo-model-canvas";
  canvas.setAttribute("aria-label", "Animated Aniimo model artwork");
  canvas.setAttribute("role", "img");
  record.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setAnimationLoop(render);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 1000);
  camera.position.set(0, 0.8, 4.2);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x182033, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(2.5, 4, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x8bb9ff, 1.4);
  fill.position.set(-3, 1, 2);
  scene.add(fill);

  let mixer = null;
  let model = null;
  let disposed = false;
  const rarityShaderUniforms = [];
  const clock = new THREE.Clock();
  let elapsed = 0;

  function hexColor(value) {
    return new THREE.Color(String(value || "#ffffff"));
  }

  function attachRarityShader(material) {
    const palette = Array.isArray(appearance.palette) ? appearance.palette.slice(0, 8) : [];
    if (palette.length !== 8) return;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uShinyTime = { value: 0 };
      shader.uniforms.uShinyPalette = { value: palette.map(hexColor) };
      shader.uniforms.uShinyMotion = { value: new THREE.Vector4(...(appearance.motion || [0.2, 0.3, 1, 5])) };
      shader.uniforms.uShinyBreathing = { value: new THREE.Vector2(...(appearance.breathing || [0.6, 0.6])) };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vShinyPosition;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvShinyPosition = position;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          uniform float uShinyTime;
          uniform vec3 uShinyPalette[8];
          uniform vec4 uShinyMotion;
          uniform vec2 uShinyBreathing;
          varying vec3 vShinyPosition;
          vec3 shinyPalette(float value) {
            float scaled = fract(value) * 7.0;
            if (scaled < 1.0) return mix(uShinyPalette[0], uShinyPalette[1], scaled);
            if (scaled < 2.0) return mix(uShinyPalette[1], uShinyPalette[2], scaled - 1.0);
            if (scaled < 3.0) return mix(uShinyPalette[2], uShinyPalette[3], scaled - 2.0);
            if (scaled < 4.0) return mix(uShinyPalette[3], uShinyPalette[4], scaled - 3.0);
            if (scaled < 5.0) return mix(uShinyPalette[4], uShinyPalette[5], scaled - 4.0);
            if (scaled < 6.0) return mix(uShinyPalette[5], uShinyPalette[6], scaled - 5.0);
            return mix(uShinyPalette[6], uShinyPalette[7], scaled - 6.0);
          }`)
        .replace("#include <dithering_fragment>", `
          float shinyPhase = vShinyPosition.y * uShinyMotion.w + vShinyPosition.x * uShinyMotion.z + uShinyTime * uShinyMotion.y;
          vec3 shinyColor = shinyPalette(shinyPhase);
          float shinyBreath = mix(uShinyBreathing.x, uShinyBreathing.y, 0.5 + 0.5 * sin(uShinyTime * 2.0));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * (0.7 + shinyColor * 1.35) + shinyColor * 0.24, clamp(shinyBreath, 0.0, 1.0));
          #include <dithering_fragment>`);
      rarityShaderUniforms.push(shader.uniforms);
    };
    material.customProgramCacheKey = () => `aniilogs-shiny-${appearance.preset || palette.join("-")}`;
    material.needsUpdate = true;
  }

  function rendererAppearance(object) {
    const config = appearance.rendererConfig;
    if (!config || typeof config !== "object") return null;
    let current = object;
    while (current) {
      const name = String(current.name || "").replace(/_\d+$/, "");
      if (Object.prototype.hasOwnProperty.call(config, name)) return config[name];
      current = current.parent;
    }
    return null;
  }

  function resize() {
    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function frameModel(root) {
    const bounds = new THREE.Box3().setFromObject(root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const height = Math.max(size.y, 0.01);
    root.position.sub(center);
    root.position.y += height * 0.5;
    const scale = 2.1 / height;
    root.scale.setScalar(scale);
    camera.position.set(0, height * scale * 0.42, Math.max(3.1, height * scale * 2.1));
    camera.lookAt(0, height * scale * 0.48, 0);
  }

  function render() {
    if (disposed || !canvas.isConnected) {
      renderer.setAnimationLoop(null);
      renderer.dispose();
      return;
    }
    resize();
    const delta = Math.min(clock.getDelta(), 0.05);
    elapsed += delta;
    rarityShaderUniforms.forEach((uniforms) => { uniforms.uShinyTime.value = elapsed; });
    if (mixer) mixer.update(delta);
    if (model) model.rotation.y += delta * 0.12;
    renderer.render(scene, camera);
  }

  const loadPromise = new Promise((resolve, reject) => new GLTFLoader().load(
    source,
    (gltf) => {
      if (disposed) return;
      model = gltf.scene;
      model.traverse((object) => {
        if (!object.isMesh) return;
        const rendererStyle = rendererAppearance(object);
        if (appearance.rendererConfig && !rendererStyle) return;
        if (rendererStyle?.enabled === false) {
          object.visible = false;
          return;
        }
        object.frustumCulled = false;
        object.castShadow = false;
        object.receiveShadow = false;
        if (object.material) {
          const wasMaterialArray = Array.isArray(object.material);
          const materials = wasMaterialArray ? object.material : [object.material];
          const styledMaterials = materials.map((material) => {
            const clone = material.clone();
            clone.side = THREE.DoubleSide;
            if (appearance.tint && clone.color && !appearance.palette) {
              // The extracted Scorchhowl showcase mesh has a neutral base
              // material.  Apply the game's rarity style color at render time
              // so the style selector changes the actual artwork.
              clone.color.set(appearance.tint);
            }
            if (appearance.emissive && clone.emissive) {
              clone.emissive.set(appearance.emissive);
              clone.emissiveIntensity = Number(appearance.emissiveIntensity || 0.18);
            }
            attachRarityShader(clone);
            return clone;
          });
          object.material = wasMaterialArray ? styledMaterials : styledMaterials[0];
        }
      });
      frameModel(model);
      scene.add(model);
      if (gltf.animations?.length) {
        mixer = new THREE.AnimationMixer(model);
        const preferred = gltf.animations.find((clip) => /Idle/i.test(clip.name)) || gltf.animations[0];
        mixer.clipAction(preferred).play();
      }
      resolve();
    },
    undefined,
    (error) => {
      canvas.classList.add("is-load-error");
      canvas.setAttribute("aria-label", "Aniimo model artwork unavailable");
      reject(error || new Error("Unable to load Aniimo model"));
    },
  ));

  const observer = new ResizeObserver(resize);
  observer.observe(record);
  record.__modelShowcaseCleanup = () => {
    disposed = true;
    observer.disconnect();
    mixer?.stopAllAction();
  };
  return loadPromise;
}
