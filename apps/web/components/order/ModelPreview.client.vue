<script setup lang="ts">
import type { ModelGeometry } from "../../utils/model-geometry";

const props = defineProps<{ geometry: ModelGeometry }>();
const canvas = ref<HTMLCanvasElement>();
const yaw = ref(-0.65);
const pitch = ref(0.45);
let resizeObserver: ResizeObserver | undefined;
let dragging = false;
let lastPointerX = 0;
let lastPointerY = 0;

function rotatedPoint(
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const cosYaw = Math.cos(yaw.value);
  const sinYaw = Math.sin(yaw.value);
  const cosPitch = Math.cos(pitch.value);
  const sinPitch = Math.sin(pitch.value);
  const yawX = x * cosYaw - z * sinYaw;
  const yawZ = x * sinYaw + z * cosYaw;
  return [yawX, y * cosPitch - yawZ * sinPitch, y * sinPitch + yawZ * cosPitch];
}

function draw(): void {
  const element = canvas.value;
  if (!element) return;
  const bounds = element.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (element.width !== width || element.height !== height) {
    element.width = width;
    element.height = height;
  }
  const context = element.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);

  const source = props.geometry.previewTriangles;
  const center = [
    props.geometry.dimensions.width / 2,
    props.geometry.dimensions.depth / 2,
    props.geometry.dimensions.height / 2,
  ];
  const projected: [number, number, number][] = [];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < source.length; index += 3) {
    const point = rotatedPoint(
      source[index]! - center[0]!,
      source[index + 1]! - center[1]!,
      source[index + 2]! - center[2]!,
    );
    projected.push(point);
    minX = Math.min(minX, point[0]);
    maxX = Math.max(maxX, point[0]);
    minY = Math.min(minY, point[1]);
    maxY = Math.max(maxY, point[1]);
  }
  const spanX = Math.max(0.001, maxX - minX);
  const spanY = Math.max(0.001, maxY - minY);
  const scale = Math.min(
    (bounds.width * 0.78) / spanX,
    (bounds.height * 0.78) / spanY,
  );
  const offsetX = bounds.width / 2 - ((minX + maxX) / 2) * scale;
  const offsetY = bounds.height / 2 + ((minY + maxY) / 2) * scale;

  context.lineJoin = "round";
  context.lineWidth = 0.65;
  context.strokeStyle = "rgba(26, 26, 22, 0.42)";
  context.fillStyle = "rgba(27, 68, 232, 0.035)";
  for (let index = 0; index < projected.length; index += 3) {
    const triangle = projected.slice(index, index + 3);
    if (triangle.length < 3) break;
    context.beginPath();
    context.moveTo(
      triangle[0]![0] * scale + offsetX,
      offsetY - triangle[0]![1] * scale,
    );
    for (const point of triangle.slice(1)) {
      context.lineTo(point[0] * scale + offsetX, offsetY - point[1] * scale);
    }
    context.closePath();
    context.fill();
    context.stroke();
  }
}

function rotate(deltaX: number, deltaY: number): void {
  yaw.value += deltaX * 0.009;
  pitch.value = Math.max(
    -Math.PI / 2,
    Math.min(Math.PI / 2, pitch.value + deltaY * 0.009),
  );
  draw();
}

function onPointerDown(event: PointerEvent): void {
  dragging = true;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  canvas.value?.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging) return;
  rotate(event.clientX - lastPointerX, event.clientY - lastPointerY);
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
}

function onPointerUp(event: PointerEvent): void {
  dragging = false;
  canvas.value?.releasePointerCapture(event.pointerId);
}

function onKeydown(event: KeyboardEvent): void {
  const movement: Record<string, [number, number]> = {
    ArrowDown: [0, 8],
    ArrowLeft: [-8, 0],
    ArrowRight: [8, 0],
    ArrowUp: [0, -8],
  };
  const delta = movement[event.key];
  if (!delta) return;
  event.preventDefault();
  rotate(delta[0], delta[1]);
}

onMounted(() => {
  resizeObserver = new ResizeObserver(draw);
  if (canvas.value) resizeObserver.observe(canvas.value);
  draw();
});
onBeforeUnmount(() => resizeObserver?.disconnect());
watch(() => props.geometry, draw, { deep: false });
</script>

<template>
  <canvas
    ref="canvas"
    aria-label="Otočný náhled modelu. Pro otočení použijte šipky nebo tažení."
    class="model-preview"
    role="img"
    tabindex="0"
    @keydown="onKeydown"
    @pointercancel="onPointerUp"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  />
</template>

<style scoped>
.model-preview {
  display: block;
  width: 100%;
  min-height: 320px;
  cursor: grab;
  touch-action: none;
}

.model-preview:active {
  cursor: grabbing;
}

.model-preview:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -4px;
}
</style>
