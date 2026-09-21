import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { clone as cloneSkeleton } from "./vendor/utils/SkeletonUtils.js";

const modelAssetCache = new Map();

function loadModelAsset(source) {
  if (!modelAssetCache.has(source)) {
    const pending = new Promise((resolve, reject) => {
      new GLTFLoader().load(source, resolve, undefined, reject);
    }).catch((error) => {
      modelAssetCache.delete(source);
      throw error;
    });
    modelAssetCache.set(source, pending);
  }
  return modelAssetCache.get(source);
}

export function attachModelShowcase(record, source, appearance = {}, resolveContentUrl = value => value) {
  const canvas = document.createElement("canvas");
  canvas.className = "catalog-aniimo-model-canvas";
  canvas.setAttribute("aria-label", "Animated Aniimo model artwork. Drag left or right to rotate.");
  canvas.setAttribute("role", "application");
  canvas.tabIndex = 0;
  record.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setAnimationLoop(render);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 1000);
  camera.position.set(0, 0.8, 4.2);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x52607a, 3.1));
  const key = new THREE.DirectionalLight(0xfff8ed, 4.2);
  key.position.set(2.5, 4, 4.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xaecbff, 2.35);
  fill.position.set(-3.5, 1.5, 3);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xf3d9ff, 1.25);
  rim.position.set(0, 3, -3);
  scene.add(rim);

  let mixer = null;
  let model = null;
  let disposed = false;
  const rarityShaderUniforms = [];
  const clock = new THREE.Clock();
  let elapsed = Number(appearance.capturedShaderTime || 0);
  const materialTime = { value: elapsed };
  // Display-only framing must remain separate from asset-space coordinates.
  const materialDisplayScale = { value: 1 };
  const materialCleanups = [];
  let framedSize = null;
  let dragPointerId = null;
  let dragStartX = 0;
  let dragStartRotation = 0;

  function rotateModelBy(delta) {
    if (!model) return;
    model.rotation.y += delta;
  }

  function handlePointerDown(event) {
    if (!model || dragPointerId !== null) return;
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartRotation = model.rotation.y;
    canvas.setPointerCapture?.(event.pointerId);
    canvas.classList.add("is-rotating");
  }

  function handlePointerMove(event) {
    if (!model || event.pointerId !== dragPointerId) return;
    model.rotation.y = dragStartRotation + (event.clientX - dragStartX) * 0.012;
  }

  function finishPointerRotation(event) {
    if (event.pointerId !== dragPointerId) return;
    canvas.releasePointerCapture?.(event.pointerId);
    dragPointerId = null;
    canvas.classList.remove("is-rotating");
  }

  function handleKeyDown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    rotateModelBy(event.key === "ArrowLeft" ? -Math.PI / 12 : Math.PI / 12);
  }

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", finishPointerRotation);
  canvas.addEventListener("pointercancel", finishPointerRotation);
  canvas.addEventListener("keydown", handleKeyDown);

  function updateCameraFrame() {
    if (!framedSize) return;
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const verticalDistance = framedSize.height / (2 * Math.tan(verticalFov / 2));
    const horizontalDistance = framedSize.width / (2 * Math.tan(horizontalFov / 2));
    const distance = Math.max(verticalDistance, horizontalDistance) * 1.12;
    camera.position.set(0, framedSize.lookY, Math.max(3.1, distance));
    camera.lookAt(0, framedSize.lookY, 0);
  }

  function attachRarityShader(material) {
    const linearPalette = Array.isArray(appearance.paletteLinear) ? appearance.paletteLinear.slice(0, 8) : [];
    const palette = linearPalette.length === 6
      ? linearPalette.map((value) => new THREE.Color().setRGB(
        Number(value?.[0] || 0),
        Number(value?.[1] || 0),
        Number(value?.[2] || 0),
      ))
      : (Array.isArray(appearance.palette) ? appearance.palette.slice(0, 6).map((value) => new THREE.Color(String(value || "#ffffff"))) : []);
    if (palette.length !== 6) return;
    const previous = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey();
    material.onBeforeCompile = (shader) => {
      previous.call(material, shader, renderer);
      shader.uniforms.uShinyTime = { value: 0 };
      shader.uniforms.uShinyPalette = { value: palette };
      shader.uniforms.uShinyCore = { value: new THREE.Vector4(...(appearance.core || [0, 2, 1, 0])) };
      shader.uniforms.uShinyMotion = { value: new THREE.Vector4(...(appearance.motion || [0.2, 0.3, 1, 5])) };
      shader.uniforms.uShinyLighting = { value: new THREE.Vector4(...(appearance.lighting || [0, 5, 0.5, 0])) };
      shader.uniforms.uShinyBreathing = { value: new THREE.Vector2(...(appearance.breathing || [0.6, 0.6])) };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vShinyUv;\nvarying vec3 vShinyGeometricNormal;")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\nvShinyUv = uv;")
        .replace("#include <defaultnormal_vertex>", "#include <defaultnormal_vertex>\nvShinyGeometricNormal = normalize(transformedNormal);");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          uniform float uShinyTime;
          uniform vec3 uShinyPalette[6];
          uniform vec4 uShinyCore;
          uniform vec4 uShinyMotion;
          uniform vec4 uShinyLighting;
          uniform vec2 uShinyBreathing;
          varying vec2 vShinyUv;
          varying vec3 vShinyGeometricNormal;
          vec3 shinyPalette(float value) {
            // The client reconstructs six RGB10A2 HDR colors from its two
            // packed float4 properties, then traverses them cyclically.
            float scaled = fract(value) * 6.0;
            if (scaled < 1.0) return mix(uShinyPalette[0], uShinyPalette[1], scaled);
            if (scaled < 2.0) return mix(uShinyPalette[1], uShinyPalette[2], scaled - 1.0);
            if (scaled < 3.0) return mix(uShinyPalette[2], uShinyPalette[3], scaled - 2.0);
            if (scaled < 4.0) return mix(uShinyPalette[3], uShinyPalette[4], scaled - 3.0);
            if (scaled < 5.0) return mix(uShinyPalette[4], uShinyPalette[5], scaled - 4.0);
            return mix(uShinyPalette[5], uShinyPalette[0], scaled - 5.0);
          }`)
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          float shinyPhase = fract(vShinyUv.x + uShinyTime * uShinyMotion.x);
          vec3 shinyColor = shinyPalette(shinyPhase);
          float viewDot = clamp(abs(dot(normalize(vShinyGeometricNormal), normalize(vViewPosition))), 0.0, 1.0);
          float shinyRange = uShinyCore.w - uShinyCore.z;
          float shinyLinear = clamp((viewDot - uShinyCore.z) / (abs(shinyRange) < 0.00001 ? 0.00001 : shinyRange), 0.0, 1.0);
          float shinyMask = shinyLinear * shinyLinear * (3.0 - 2.0 * shinyLinear);
          shinyMask = pow(max(shinyMask, 0.000001), max(uShinyCore.y, 0.01));
          float breathPhase = fract(vShinyUv.x + uShinyTime * uShinyMotion.y);
          float breathShape = 1.0 - clamp(abs(breathPhase - 0.5) / max(uShinyLighting.z, 0.0001), 0.0, 1.0);
          float breath = 1.0 + 0.5 * uShinyLighting.y * breathShape;
          // The shipped program keeps the decoded RGB10A2 values in linear
          // HDR and lets tone mapping handle their display energy.
          shinyColor *= breath * max(uShinyBreathing.x, uShinyBreathing.y);
          shinyColor = mix(shinyColor, totalEmissiveRadiance, clamp(uShinyLighting.x, 0.0, 1.0));
          // Exact final two-instruction form in the shipped DXBC:
          //   delta = shiny * intensity - authoredEmission
          //   authoredEmission += fresnelMask * delta
          // i.e. a masked blend, not additive emission.
          // Blend emission before lighting composition. Blending gl_FragColor
          // here would incorrectly replace the lit base/armor with the effect.
          totalEmissiveRadiance = mix(totalEmissiveRadiance, shinyColor, shinyMask);`);
      rarityShaderUniforms.push(shader.uniforms);
    };
    material.customProgramCacheKey = () => `${previousKey}-aniilogs-shiny-${appearance.preset || palette.join("-")}`;
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

  function materialAppearance(rendererStyle, material) {
    const configured = rendererStyle?.materials;
    if (!configured || typeof configured !== "object") return [];
    const materialName = String(material?.name || "");
    const matching = Object.entries(configured).find(([name]) => materialName.includes(name));
    if (!matching) return [];
    return Object.values(matching[1] || {}).filter((value) => value && typeof value === "object");
  }

  function materialIsAuthoredForStyle(rendererStyle, material) {
    if (!rendererStyle || typeof rendererStyle !== "object") return false;
    const materialName = String(material?.name || "");
    const configured = Object.keys(rendererStyle.materials || {})
      .some((name) => materialName.includes(name));
    const substituted = Object.keys(rendererStyle.materialEffects || {})
      .some((name) => materialName.includes(name));
    return configured || substituted;
  }

  function colorProperty(properties, names) {
    const colors = properties?.colors || {};
    for (const name of names) {
      const value = colors[name];
      if (Array.isArray(value) && value.length >= 3) return value;
    }
    return null;
  }

  function applyExtractedPresets(material, presets) {
    let baseColor = null;
    let emissiveColor = null;
    let emissiveStrength = 0;
    presets.forEach((preset) => {
      const properties = preset.properties || {};
      baseColor ||= colorProperty(properties, ["_BaseColor", "_MainTex_Color_Front"]);
      const directEmission = colorProperty(properties, [
        "_EmissiveColor",
        "_EmissiveFlowColor",
        "_FresnelColor",
        "_VFXFresnelPluginModel_FresnelColor",
        "_MainTex_Color_Front",
      ]);
      // ParmonDye colors are inputs to the game's mask/gradient plugin, not
      // ordinary PBR emissive colors. Keep them for the dedicated dye shader;
      // only apply material properties that the authored preset sets directly.
      const candidate = directEmission;
      if (candidate) {
        emissiveColor = candidate;
        emissiveStrength = Math.max(emissiveStrength, ...candidate.slice(0, 3).map(Number));
      }
    });
    if (baseColor && material.color) {
      material.color.setRGB(Number(baseColor[0]), Number(baseColor[1]), Number(baseColor[2]));
    }
    if (emissiveColor && material.emissive) {
      const peak = Math.max(1, ...emissiveColor.slice(0, 3).map(Number));
      material.emissive.setRGB(
        Number(emissiveColor[0]) / peak,
        Number(emissiveColor[1]) / peak,
        Number(emissiveColor[2]) / peak,
      );
      material.emissiveIntensity = Math.max(0.2, Math.min(8, emissiveStrength));
    }
  }

  function applyRuntimeMaterialOverride(material) {
    const overrides = appearance.runtimeMaterialOverrides;
    if (!overrides || typeof overrides !== "object") return;
    const materialName = String(material?.name || "");
    const match = Object.entries(overrides).find(([name]) => materialName.includes(name));
    const properties = match?.[1]?.properties;
    if (!properties) return;
    const base = properties._BaseColor;
    if (Array.isArray(base) && material.color) {
      material.color.setRGB(Number(base[0]), Number(base[1]), Number(base[2]));
      material.opacity = Number(base[3] ?? material.opacity);
    }
    const emissive = properties._EmissiveColor;
    if (Array.isArray(emissive) && material.emissive) {
      const peak = Math.max(1, ...emissive.slice(0, 3).map(Number));
      material.emissive.setRGB(
        Number(emissive[0]) / peak,
        Number(emissive[1]) / peak,
        Number(emissive[2]) / peak,
      );
      material.emissiveIntensity = peak;
    }
    if (Array.isArray(properties._Metallic)) material.metalness = Number(properties._Metallic[0]);
    if (Array.isArray(properties._Roughness)) material.roughness = Number(properties._Roughness[0]);
  }

  function resize() {
    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    updateCameraFrame();
  }

  function visibleModelBounds(root) {
    const bounds = new THREE.Box3();
    const meshBounds = new THREE.Box3();
    root.updateWorldMatrix(true, true);
    root.traverse((object) => {
      if (!object.visible || !object.isMesh || !object.geometry) return;
      if (object.isSkinnedMesh && typeof object.computeBoundingBox === "function") {
        object.computeBoundingBox();
        if (object.boundingBox) bounds.union(meshBounds.copy(object.boundingBox).applyMatrix4(object.matrixWorld));
        return;
      }
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      if (object.geometry.boundingBox) bounds.union(meshBounds.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld));
    });
    return bounds.isEmpty() ? new THREE.Box3().setFromObject(root) : bounds;
  }

  function frameModel(root) {
    const bounds = visibleModelBounds(root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const height = Math.max(size.y, 0.01);
    root.position.sub(center);
    root.position.y += height * 0.5;
    const scale = 2.1 / height;
    materialDisplayScale.value = scale;
    root.scale.setScalar(scale);
    framedSize = {
      height: height * scale,
      width: Math.max(size.x * scale, 0.01),
      lookY: height * scale * 0.48,
    };
    updateCameraFrame();
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
    materialTime.value = elapsed;
    rarityShaderUniforms.forEach((uniforms) => { uniforms.uShinyTime.value = elapsed; });
    if (mixer) mixer.update(delta);
    renderer.render(scene, camera);
  }

  const loadPromise = loadModelAsset(source)
    .then(async (asset) => {
      const gltf = {
        scene: cloneSkeleton(asset.scene),
        animations: asset.animations,
      };
      if (disposed) return;
      const materialTasks = [];
      const dyeAdapter = appearance.dyeShaderModule
        ? await import(resolveContentUrl(appearance.dyeShaderModule)) : null;
      const authoredAdapter = appearance.authoredShaderModule
        ? await import(resolveContentUrl(appearance.authoredShaderModule)) : null;
      const authoredRuntime = appearance.authoredRuntime
        ? await fetch(resolveContentUrl(appearance.authoredRuntime)).then((response) => {
          if (!response.ok) throw new Error(`Unable to load authored runtime (${response.status})`);
          return response.json();
        }) : null;
      const authoredRuntimeUrl = appearance.authoredRuntime
        ? new URL(resolveContentUrl(appearance.authoredRuntime), window.location.href) : null;
      model = gltf.scene;
      model.traverse((object) => {
        if (!object.isMesh) return;
        const rendererStyle = rendererAppearance(object);
        if (appearance.rendererConfig && !rendererStyle) {
          // ParmonDyeData is an allow-list for the selected style. Returning
          // without hiding this renderer left mutually exclusive form parts
          // stacked together, which made most Pawney rarities look alike.
          object.visible = false;
          return;
        }
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
            if (appearance.rendererConfig && !materialIsAuthoredForStyle(rendererStyle, material)) {
              // A renderer can contain multiple GLB primitives, while the
              // game's style plan activates only selected material slots.
              clone.visible = false;
              return clone;
            }
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
            const presets = materialAppearance(rendererStyle, material);
            if (!appearance.authoredRuntime) {
              applyExtractedPresets(clone, presets);
            }
            // Captured runtime overrides are part of the authoritative base
            // surface that the dye stage receives. Only the older extracted
            // preset approximation is bypassed for authored runtimes.
            applyRuntimeMaterialOverride(clone);
            // Do not apply the former whole-material palette approximation.
            // The game-authored renderer/material plan below already carries
            // each appearance's per-plugin dye and emission parameters. The
            // broad overlay ignored those masks and turned armor, crystal,
            // eyes, and translucent parts into the same neon color.
            const dyeBinding = Object.entries(rendererStyle?.resolvedDyeBindings || {})
              .find(([name]) => String(material.name || '').includes(name))?.[1];
            if (dyeBinding) {
              if (!dyeAdapter) throw new Error('Authored dye adapter is missing');
              materialTasks.push(dyeAdapter.attachDye(THREE, clone, dyeBinding, resolveContentUrl, {
                time: materialTime, displayScale: materialDisplayScale, object, root: model,
              })
                .then(cleanup => {
                  if (appearance.gameShiny) attachRarityShader(clone);
                  if (disposed) cleanup(); else materialCleanups.push(cleanup);
                }));
            } else if (authoredAdapter && authoredRuntime && appearance.authoredRuntimeCompositor !== 'deferred-mrt') {
              materialTasks.push(authoredAdapter.createAuthoredMaterial({
                THREE,
                object,
                fallbackMaterial: clone,
                runtime: authoredRuntime,
                runtimeUrl: authoredRuntimeUrl,
                rarityId: appearance.authoredRuntimeVariant || appearance.rarityId || appearance.id || 'common',
              }).then((authoredMaterial) => {
                if (disposed || !authoredMaterial) return;
                const current = Array.isArray(object.material) ? object.material : [object.material];
                const index = current.indexOf(clone);
                if (index < 0) return;
                current[index] = authoredMaterial;
                object.material = wasMaterialArray ? current : current[0];
              }));
            } else if (appearance.gameShiny) {
              attachRarityShader(clone);
            }
            return clone;
          });
          object.material = wasMaterialArray ? styledMaterials : styledMaterials[0];
        }
      });
      await Promise.all(materialTasks);
      if (disposed) return;
      scene.add(model);
      if (gltf.animations?.length) {
        mixer = new THREE.AnimationMixer(model);
        const preferred = gltf.animations.find((clip) => /Idle/i.test(clip.name)) || gltf.animations[0];
        mixer.clipAction(preferred).play();
        mixer.update(1 / 60);
      }
      frameModel(model);
    })
    .catch((error) => {
      canvas.classList.add("is-load-error");
      canvas.setAttribute("aria-label", "Aniimo model artwork unavailable");
      throw error || new Error("Unable to load Aniimo model");
    });

  const observer = new ResizeObserver(resize);
  observer.observe(record);
  record.__modelShowcaseCleanup = () => {
    disposed = true;
    observer.disconnect();
    mixer?.stopAllAction();
    materialCleanups.forEach(cleanup => cleanup());
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerup", finishPointerRotation);
    canvas.removeEventListener("pointercancel", finishPointerRotation);
    canvas.removeEventListener("keydown", handleKeyDown);
  };
  return loadPromise;
}
