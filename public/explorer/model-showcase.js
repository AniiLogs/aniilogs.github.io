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
  const clock = new THREE.Clock();

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
    if (mixer) mixer.update(delta);
    if (model) model.rotation.y += delta * 0.12;
    renderer.render(scene, camera);
  }

  new GLTFLoader().load(
    source,
    (gltf) => {
      if (disposed) return;
      model = gltf.scene;
      model.traverse((object) => {
        if (!object.isMesh) return;
        object.frustumCulled = false;
        object.castShadow = false;
        object.receiveShadow = false;
        if (object.material) {
          const wasMaterialArray = Array.isArray(object.material);
          const materials = wasMaterialArray ? object.material : [object.material];
          const styledMaterials = materials.map((material) => {
            const clone = material.clone();
            clone.side = THREE.DoubleSide;
            if (appearance.tint && clone.color) {
              // The extracted Scorchhowl showcase mesh has a neutral base
              // material.  Apply the game's rarity style color at render time
              // so the style selector changes the actual artwork.
              clone.color.set(appearance.tint);
            }
            if (appearance.emissive && clone.emissive) {
              clone.emissive.set(appearance.emissive);
              clone.emissiveIntensity = Number(appearance.emissiveIntensity || 0.18);
            }
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
    },
    undefined,
    () => {
      canvas.classList.add("is-load-error");
      canvas.setAttribute("aria-label", "Aniimo model artwork unavailable");
    },
  );

  const observer = new ResizeObserver(resize);
  observer.observe(record);
  record.__modelShowcaseCleanup = () => {
    disposed = true;
    observer.disconnect();
    mixer?.stopAllAction();
  };
}
