import { $ } from './common';
import { RxController } from './rx';

const video = $<HTMLVideoElement>('#video');
const ui = {
  startCam: $<HTMLButtonElement>('#startCam'),
  lock: $<HTMLButtonElement>('#lock'),
  camera: $<HTMLSelectElement>('#camera'),
  res: $<HTMLSelectElement>('#res'),
  crop: $<HTMLSelectElement>('#crop'),
  decoders: $<HTMLInputElement>('#decoders'),
  camInfo: $<HTMLElement>('#camInfo'),
  roi: $<HTMLElement>('#roi'),
  flash: $<HTMLElement>('#flash'),
};

const rx = new RxController(
  {
    banner: $('#banner'),
    recoveredBar: $('#recoveredBar'),
    uniqueBar: $('#uniqueBar'),
    stats: $('#stats'),
    save: $('#save'),
    reset: $('#reset'),
    switchBtn: $('#switch'),
  },
  'receive',
  Number(ui.decoders.value),
);
let flashTimer = 0;
rx.onDecoded = (_id, n) => {
  if (!n) return;
  ui.flash.classList.add('hit');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => ui.flash.classList.remove('hit'), 150);
};

let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;
let locked = false;

async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const current = ui.camera.value;
  ui.camera.innerHTML = '<option value="">Default (rear if available)</option>';
  for (const d of devices.filter((d) => d.kind === 'videoinput')) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${ui.camera.options.length}`;
    ui.camera.append(o);
  }
  ui.camera.value = current;
}

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const [width, height] = ui.res.value.split('x').map(Number);
  const video_: MediaTrackConstraints = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: 30 },
  };
  if (ui.camera.value) video_.deviceId = { exact: ui.camera.value };
  else video_.facingMode = { ideal: 'environment' };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: video_, audio: false });
  } catch (e) {
    ui.camInfo.textContent = `Camera error: ${(e as Error).message}`;
    return;
  }
  track = stream.getVideoTracks()[0];
  locked = false;
  ui.lock.textContent = 'Lock focus/exposure';
  // Continuous AF/AE to start with, where the platform exposes it.
  const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
  const adv: Record<string, unknown> = {};
  if ((caps.focusMode as string[] | undefined)?.includes('continuous')) adv.focusMode = 'continuous';
  if ((caps.exposureMode as string[] | undefined)?.includes('continuous')) adv.exposureMode = 'continuous';
  if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] }).catch(() => {});
  ui.lock.disabled = !(caps.focusMode || caps.exposureMode);
  video.srcObject = stream;
  await video.play();
  await listCameras();
  const st = track.getSettings();
  ui.camInfo.textContent = `${track.label} · ${st.width}×${st.height} @ ${st.frameRate ?? '?'} fps${ui.lock.disabled ? ' · focus/exposure control not supported' : ''}`;
  ui.startCam.textContent = 'Restart camera';
  updateRoi();
  video.requestVideoFrameCallback(onVideoFrame);
}

async function toggleLock() {
  if (!track) return;
  const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
  const st = track.getSettings() as Record<string, unknown>;
  const adv: Record<string, unknown> = {};
  if (!locked) {
    if ((caps.focusMode as string[] | undefined)?.includes('manual')) {
      adv.focusMode = 'manual';
      if (st.focusDistance !== undefined) adv.focusDistance = st.focusDistance;
    }
    if ((caps.exposureMode as string[] | undefined)?.includes('manual')) {
      adv.exposureMode = 'manual';
      if (st.exposureTime !== undefined) adv.exposureTime = st.exposureTime;
    }
  } else {
    if ((caps.focusMode as string[] | undefined)?.includes('continuous')) adv.focusMode = 'continuous';
    if ((caps.exposureMode as string[] | undefined)?.includes('continuous')) adv.exposureMode = 'continuous';
  }
  try {
    await track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] });
    locked = !locked;
    ui.lock.textContent = locked ? 'Unlock focus/exposure' : 'Lock focus/exposure';
  } catch (e) {
    ui.camInfo.textContent = `Could not change focus/exposure: ${(e as Error).message}`;
  }
}

function onVideoFrame() {
  if (!stream?.active) return;
  video.requestVideoFrameCallback(onVideoFrame);
  if (!rx.idle || video.readyState < 2) return; // drop: all decoders busy
  const crop = Number(ui.crop.value);
  if (typeof VideoFrame !== 'undefined') {
    const frame = new VideoFrame(video);
    if (rx.submit({ type: 'image', image: frame, crop }, [frame]) === null) frame.close();
  } else {
    createImageBitmap(video).then((bmp) => {
      if (rx.submit({ type: 'image', image: bmp, crop }, [bmp]) === null) bmp.close();
    });
  }
}

function updateRoi() {
  const c = Number(ui.crop.value);
  ui.roi.classList.toggle('hidden', c === 1);
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const box = video.getBoundingClientRect();
  const scale = Math.min(box.width / vw, box.height / vh);
  ui.roi.style.width = `${vw * scale * c}px`;
  ui.roi.style.height = `${vh * scale * c}px`;
}

ui.startCam.onclick = startCamera;
ui.startCam.disabled = !rx.available;
ui.lock.onclick = toggleLock;
ui.camera.onchange = () => stream && startCamera();
ui.res.onchange = () => stream && startCamera();
ui.crop.onchange = updateRoi;
ui.decoders.onchange = () => rx.setDecoders(Math.max(1, Math.min(8, Number(ui.decoders.value) || 1)));
window.addEventListener('resize', updateRoi);
