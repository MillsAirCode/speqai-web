// SpeqAI Voice Client
// Handles audio capture, resampling, and playback

const SAMPLE_RATE = 24000;  // Target sample rate for PersonaPlex
const FRAME_SIZE = 480;     // 20ms at 24kHz

let ws = null;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let isRecording = false;
let playbackQueue = [];
let isPlaying = false;

// UI Elements
const connectBtn = document.getElementById('connectBtn');
const talkBtn = document.getElementById('talkBtn');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const visualizer = document.getElementById('visualizer');

// Create visualizer bars
for (let i = 0; i < 32; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.height = '4px';
  visualizer.appendChild(bar);
}
const bars = visualizer.querySelectorAll('.bar');

function log(msg, type = '') {
  const line = document.createElement('div');
  line.className = type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(msg);
}

function setStatus(status, text) {
  statusEl.className = status;
  statusEl.textContent = text;
}

// Resample audio from source rate to target rate
function resample(inputBuffer, fromRate, toRate) {
  if (fromRate === toRate) {
    return inputBuffer;
  }
  
  const ratio = fromRate / toRate;
  const outputLength = Math.round(inputBuffer.length / ratio);
  const output = new Float32Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, inputBuffer.length - 1);
    const t = srcIndex - srcIndexFloor;
    
    // Linear interpolation
    output[i] = inputBuffer[srcIndexFloor] * (1 - t) + inputBuffer[srcIndexCeil] * t;
  }
  
  return output;
}

// Convert Float32 to Int16 PCM
function floatTo16BitPCM(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

// Convert Int16 PCM to Float32
function int16ToFloat32(int16Array) {
  const float32 = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32[i] = int16Array[i] / (int16Array[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return float32;
}

// Update visualizer
function updateVisualizer(data) {
  const step = Math.floor(data.length / bars.length);
  for (let i = 0; i < bars.length; i++) {
    const idx = i * step;
    const value = Math.abs(data[idx] || 0);
    const height = Math.max(4, value * 100);
    bars[i].style.height = `${height}px`;
  }
}

// Play received audio
async function playAudio(pcmData) {
  if (!audioContext) return;
  
  // PCM data is Int16, convert to Float32
  const int16 = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);
  const float32 = int16ToFloat32(int16);
  
  // Create audio buffer at 24kHz
  const audioBuffer = audioContext.createBuffer(1, float32.length, SAMPLE_RATE);
  audioBuffer.getChannelData(0).set(float32);
  
  // Queue for playback
  playbackQueue.push(audioBuffer);
  
  if (!isPlaying) {
    playNext();
  }
}

function playNext() {
  if (playbackQueue.length === 0) {
    isPlaying = false;
    return;
  }
  
  isPlaying = true;
  const buffer = playbackQueue.shift();
  
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.onended = playNext;
  source.start();
  
  // Update visualizer with playback
  updateVisualizer(buffer.getChannelData(0));
}

// Connect to proxy server
async function connect() {
  const prompt = document.getElementById('prompt').value;
  const voice = document.getElementById('voice').value;
  const model = document.getElementById('model').value;
  
  setStatus('connecting', 'Connecting...');
  log('Connecting to proxy server...', 'info');
  
  // Get WebSocket URL (same host as page)
  const wsUrl = `ws://${window.location.host}`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    log('Connected to proxy', 'success');
    
    // Request connection to PersonaPlex
    ws.send(JSON.stringify({
      type: 'connect',
      prompt,
      voice,
      model
    }));
  };
  
  ws.onmessage = async (event) => {
    if (event.data instanceof Blob) {
      // Binary = PCM audio
      const arrayBuffer = await event.data.arrayBuffer();
      const pcmData = new Uint8Array(arrayBuffer);
      playAudio(pcmData);
    } else {
      // Text = control message
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'connected') {
          setStatus('connected', 'Connected to PersonaPlex');
          log('PersonaPlex connected!', 'success');
          connectBtn.style.display = 'none';
          talkBtn.style.display = 'block';
          await initAudio();
        } else if (msg.type === 'disconnected') {
          setStatus('disconnected', 'Disconnected');
          log(`Disconnected: ${msg.reason}`, 'error');
          resetUI();
        } else if (msg.type === 'error') {
          log(`Error: ${msg.message}`, 'error');
        } else {
          log(`Message: ${JSON.stringify(msg)}`, 'info');
        }
      } catch (e) {
        log(`Received: ${event.data}`, 'info');
      }
    }
  };
  
  ws.onclose = () => {
    setStatus('disconnected', 'Disconnected');
    log('Connection closed', 'error');
    resetUI();
  };
  
  ws.onerror = (err) => {
    log('WebSocket error', 'error');
    console.error(err);
  };
}

function resetUI() {
  connectBtn.style.display = 'block';
  connectBtn.disabled = false;
  talkBtn.style.display = 'none';
  stopRecording();
}

// Initialize audio capture
async function initAudio() {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000  // Browser native, we'll resample
    });
    
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 48000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    
    log('Microphone ready', 'success');
  } catch (err) {
    log(`Microphone error: ${err.message}`, 'error');
  }
}

// Start recording and sending audio
function startRecording() {
  if (!audioContext || !mediaStream || !ws) return;
  
  isRecording = true;
  talkBtn.classList.add('active');
  talkBtn.textContent = '🔴 Recording...';
  
  const source = audioContext.createMediaStreamSource(mediaStream);
  
  // Use ScriptProcessor for capturing (AudioWorklet would be cleaner but more complex)
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  
  let pcmBuffer = new Float32Array(0);
  
  scriptProcessor.onaudioprocess = (e) => {
    if (!isRecording) return;
    
    const input = e.inputBuffer.getChannelData(0);
    
    // Update visualizer
    updateVisualizer(input);
    
    // Resample from 48kHz to 24kHz
    const resampled = resample(input, audioContext.sampleRate, SAMPLE_RATE);
    
    // Accumulate samples
    const newBuffer = new Float32Array(pcmBuffer.length + resampled.length);
    newBuffer.set(pcmBuffer);
    newBuffer.set(resampled, pcmBuffer.length);
    pcmBuffer = newBuffer;
    
    // Send in FRAME_SIZE chunks (480 samples = 20ms at 24kHz)
    while (pcmBuffer.length >= FRAME_SIZE) {
      const frame = pcmBuffer.slice(0, FRAME_SIZE);
      pcmBuffer = pcmBuffer.slice(FRAME_SIZE);
      
      // Convert to Int16 and send
      const int16 = floatTo16BitPCM(frame);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(int16.buffer);
      }
    }
  };
  
  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);
  
  log('Recording started', 'info');
}

function stopRecording() {
  isRecording = false;
  talkBtn.classList.remove('active');
  talkBtn.textContent = '🎤 Hold to Talk';
  
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  
  // Reset visualizer
  bars.forEach(bar => bar.style.height = '4px');
  
  log('Recording stopped', 'info');
}

// Event listeners
connectBtn.addEventListener('click', () => {
  connectBtn.disabled = true;
  connect();
});

// Push-to-talk
talkBtn.addEventListener('mousedown', startRecording);
talkBtn.addEventListener('mouseup', stopRecording);
talkBtn.addEventListener('mouseleave', stopRecording);

// Touch support for mobile
talkBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startRecording();
});
talkBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  stopRecording();
});

log('Ready - click Connect to start', 'info');
