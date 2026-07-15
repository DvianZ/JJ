// app.js

const state = {
    xmlDoc: null,
    mediaMap: {},     // uri -> media info
    userMedia: {},    // uri -> HTMLImageElement
    shapes: [],       // array of parsed shapes
    fps: 120,
    totalTime: 0,     // ms
    isPlaying: false,
    currentTime: 0,   // ms
    lastRenderTime: 0,
    audioCtx: null,
    audioBuffer: null,
    audioSource: null,
    startTimeRaw: 0,  // performance.now() when playback starts
    mediaRecorder: null,
    recordedChunks: []
};

const UI = {
    canvas: document.getElementById('videoCanvas'),
    ctx: document.getElementById('videoCanvas').getContext('2d', { willReadFrequently: true }),
    slotsContainer: document.getElementById('slotsContainer'),
    btnPlayPause: document.getElementById('btnPlayPause'),
    btnExport: document.getElementById('btnExport'),
    progressBar: document.getElementById('progressBar'),
    currentTimeLabel: document.getElementById('currentTime'),
    totalTimeLabel: document.getElementById('totalTime'),
    canvasOverlay: document.getElementById('canvasOverlay'),
    audioInput: document.getElementById('audioInput'),
    renderStatus: document.getElementById('renderStatus'),
    renderProgress: document.getElementById('renderProgress')
};



async function loadTemplate(filename) {
    try {
        // Reset state for new template
        state.shapes = [];
        state.userMedia = {};
        state.mediaMap = {};
        UI.slotsContainer.innerHTML = '<div class="loading-slots">Analyzing XML...</div>';
        UI.btnPlayPause.textContent = 'Play';
        state.isPlaying = false;
        state.currentTime = 0;
        UI.progressBar.value = 0;
        UI.currentTimeLabel.textContent = "00:00";
        UI.canvasOverlay.classList.remove('hidden');
        UI.canvasOverlay.querySelector('.status-text').textContent = `Loading ${filename}...`;

        // Tambahkan timestamp acak agar browser tidak memuat dari Cache
        const noCacheUrl = `${filename}?t=${new Date().getTime()}`;
        const response = await fetch(noCacheUrl);

        if (!response.ok) throw new Error(`Could not load ${filename}`);
        const xmlText = await response.text();

        const parser = new DOMParser();
        state.xmlDoc = parser.parseFromString(xmlText, "application/xml");

        parseXML();
        UI.canvasOverlay.querySelector('.status-text').textContent = "Template Loaded! Upload your photos.";
        setTimeout(() => UI.canvasOverlay.classList.add('hidden'), 1500);

    } catch (e) {
        console.error(e);
        UI.canvasOverlay.querySelector('.status-text').textContent = `Error: ${filename} not found.`;
    }
}

function parseXML() {
    const root = state.xmlDoc.querySelector('scene');
    if (!root) return;

    state.totalTime = parseInt(root.getAttribute('totalTime') || 0);
    state.fps = parseInt(root.getAttribute('fps') || 30);

    // Parse Dimensions and Resize Canvas
    state.width = parseFloat(root.getAttribute('width')) || 1080;
    state.height = parseFloat(root.getAttribute('height')) || 1920;
    UI.canvas.width = state.width;
    UI.canvas.height = state.height;

    UI.totalTimeLabel.textContent = formatTime(state.totalTime);
    UI.progressBar.max = state.totalTime;

    // Parse Media Map
    const medias = root.querySelectorAll('media');
    medias.forEach(m => {
        const uri = m.getAttribute('uri');
        const type = m.getAttribute('type');
        if (type && (type.startsWith('image') || type.startsWith('video'))) {
            state.mediaMap[uri] = {
                uri,
                filename: m.getAttribute('filename'),
                type
            };
        }
    });

    // Fallback: Extract media directly from shapes if no <media> tags exist
    if (Object.keys(state.mediaMap).length === 0) {
        const allShapes = root.querySelectorAll('shape');
        allShapes.forEach(shape => {
            const fillType = shape.getAttribute('fillType');
            const fillMedia = shape.getAttribute('fillImage') || shape.getAttribute('fillVideo');
            if (fillType === 'media' && fillMedia && fillMedia.trim() !== '') {
                if (!state.mediaMap[fillMedia]) {
                    state.mediaMap[fillMedia] = {
                        uri: fillMedia,
                        filename: shape.getAttribute('label') || 'Extracted Image',
                        type: 'image/png'
                    };
                }
            }
        });
    }

    // Generate UI slots
    UI.slotsContainer.innerHTML = '';
    Object.keys(state.mediaMap).forEach((uri, index) => {
        createMediaSlot(uri, `Photo ${index + 1}`);
    });

    // Parse Shapes (Layers)
    const shapes = root.querySelectorAll('shape');
    shapes.forEach(shape => {
        const startTime = parseInt(shape.getAttribute('startTime') || 0);
        const endTime = parseInt(shape.getAttribute('endTime') || 0);
        const fillImage = shape.getAttribute('fillImage') || shape.getAttribute('fillVideo');

        // Parse Transform Keyframes (anak langsung saja, hindari ambil dari embedScene)
        const transform = shape.querySelector(':scope > transform');
        let locKfs = [];
        let scaleKfs = [];
        let opacityKfs = [];
        let rotKfs = [];

        if (transform) {
            const locNode = transform.querySelector('location');
            if (locNode) {
                if (locNode.getAttribute('value')) {
                    locKfs.push({ t: 0, val: parseVec3(locNode.getAttribute('value')), ease: 'linear' });
                } else {
                    locNode.querySelectorAll('kf').forEach(kf => {
                        locKfs.push({
                            t: parseFloat(kf.getAttribute('t')),
                            val: parseVec3(kf.getAttribute('v')),
                            ease: kf.getAttribute('e') || 'linear'
                        });
                    });
                    locKfs.sort((a, b) => a.t - b.t);
                }
            }

            const scaleNode = transform.querySelector('scale');
            if (scaleNode) {
                scaleNode.querySelectorAll('kf').forEach(kf => {
                    scaleKfs.push({
                        t: parseFloat(kf.getAttribute('t')),
                        val: parseVec2(kf.getAttribute('v')),
                        ease: kf.getAttribute('e') || 'linear'
                    });
                });
                scaleKfs.sort((a, b) => a.t - b.t);
            }

            const opacityNode = transform.querySelector('opacity');
            if (opacityNode) {
                if (opacityNode.getAttribute('value')) {
                    opacityKfs.push({ t: 0, val: parseFloat(opacityNode.getAttribute('value')), ease: 'linear' });
                } else {
                    opacityNode.querySelectorAll('kf').forEach(kf => {
                        opacityKfs.push({
                            t: parseFloat(kf.getAttribute('t')),
                            val: parseFloat(kf.getAttribute('v')),
                            ease: kf.getAttribute('e') || 'linear'
                        });
                    });
                    opacityKfs.sort((a, b) => a.t - b.t);
                }
            }

            const rotNode = transform.querySelector('rotation');
            if (rotNode) {
                if (rotNode.getAttribute('value')) {
                    rotKfs.push({ t: 0, val: parseFloat(rotNode.getAttribute('value')), ease: 'linear' });
                } else {
                    rotNode.querySelectorAll('kf').forEach(kf => {
                        rotKfs.push({
                            t: parseFloat(kf.getAttribute('t')),
                            val: parseFloat(kf.getAttribute('v')),
                            ease: kf.getAttribute('e') || 'linear'
                        });
                    });
                    rotKfs.sort((a, b) => a.t - b.t);
                }
            }
        }

        let effects = [];
        const effectNodes = shape.querySelectorAll('effect');
        effectNodes.forEach(eff => {
            let effId = eff.getAttribute('id');
            let props = {};
            eff.querySelectorAll('property').forEach(prop => {
                let name = prop.getAttribute('name');
                let value = prop.getAttribute('value');
                let kfs = [];
                if (value !== null) {
                    kfs.push({ t: 0, val: parseFloat(value), ease: 'linear' });
                } else {
                    prop.querySelectorAll('kf').forEach(kf => {
                        kfs.push({
                            t: parseFloat(kf.getAttribute('t')),
                            val: parseFloat(kf.getAttribute('v')),
                            ease: kf.getAttribute('e') || 'linear'
                        });
                    });
                    kfs.sort((a, b) => a.t - b.t);
                }
                props[name] = kfs;
            });
            effects.push({ id: effId, props });
        });

        // Extract nested embedScene transforms
        let embedOffsetX = 0;
        let embedOffsetY = 0;
        let embedScaleX = 1.0;
        let embedScaleY = 1.0;

        let currentParent = shape.parentElement;
        while (currentParent) {
            if (currentParent.tagName === 'embedScene') {
                const tr = currentParent.querySelector(':scope > transform');
                if (tr) {
                    const loc = tr.querySelector('location');
                    if (loc && loc.getAttribute('value')) {
                        const l = parseVec3(loc.getAttribute('value'));
                        embedOffsetX += (l.x - (state.width / 2));
                        embedOffsetY += (l.y - (state.height / 2));
                    }
                    const sc = tr.querySelector('scale');
                    if (sc && sc.getAttribute('value')) {
                        const s = parseVec2(sc.getAttribute('value'));
                        embedScaleX *= s.x;
                        embedScaleY *= s.y;
                    }
                }
            }
            currentParent = currentParent.parentElement;
        }

        let shapeSizeX = state.width;
        let shapeSizeY = state.height;
        const sizeProp = shape.querySelector(':scope > property[name="size"]') || shape.querySelector('property[name="size"]');
        if (sizeProp) {
            const size = parseVec2(sizeProp.getAttribute('value'));
            // Alight Motion sizes are often half-extents (radius from center)
            shapeSizeX = size.x * 2;
            shapeSizeY = size.y * 2;
        }

        // If it's a solid color (e.g. background)
        const fillType = shape.getAttribute('fillType');
        let fillColor = null;
        if (fillType === 'color') {
            const colorAttr = shape.getAttribute('fillColor');
            if (colorAttr) {
                // Alight Motion colors are often ARGB hex (e.g. #ff000000)
                // We'll need to handle it in renderFrame
                fillColor = colorAttr;
            }
        }

        state.shapes.push({
            id: shape.getAttribute('id'),
            startTime,
            endTime,
            fillType,
            fillImage,
            fillColor,
            locKfs,
            scaleKfs,
            opacityKfs,
            rotKfs,
            effects,
            embedOffsetX,
            embedOffsetY,
            embedScaleX,
            embedScaleY,
            shapeSizeX,
            shapeSizeY
        });
    });

    checkReadyState();
}

// Bezier Solver
function solveBezier(p1x, p1y, p2x, p2y, t) {
    if (p1x === p1y && p2x === p2y) return t; // linear
    let ax = 3 * p1x, bx = 3 * (p2x - p1x) - ax, cx = 1 - ax - bx;
    let ay = 3 * p1y, by = 3 * (p2y - p1y) - ay, cy = 1 - ay - by;
    function sampleX(t) { return ((cx * t + bx) * t + ax) * t; }
    function sampleY(t) { return ((cy * t + by) * t + ay) * t; }
    function sampleDx(t) { return (3 * cx * t + 2 * bx) * t + ax; }
    let t2 = t;
    for (let i = 0; i < 8; i++) {
        let x2 = sampleX(t2) - t;
        if (Math.abs(x2) < 0.001) return sampleY(t2);
        const d2 = sampleDx(t2);
        if (Math.abs(d2) < 1e-6) break;
        t2 = t2 - x2 / d2;
    }
    return sampleY(t2);
}

function applyEase(p, easeStr) {
    if (!easeStr || easeStr === 'linear') return p;
    if (easeStr.startsWith('cubicBezier')) {
        let parts = easeStr.replace('cubicBezier', '').trim().split(' ').map(parseFloat);
        if (parts.length === 4) {
            return solveBezier(parts[0], parts[1], parts[2], parts[3], p);
        }
    }
    return p;
}

function evalProp(kfs, currentT) {
    if (!kfs || kfs.length === 0) return 0;
    if (kfs.length === 1) return kfs[0].val;
    if (currentT <= kfs[0].t) return kfs[0].val;
    if (currentT >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].val;

    let kf1 = kfs[0], kf2 = kfs[kfs.length - 1];
    for (let i = 0; i < kfs.length - 1; i++) {
        if (currentT >= kfs[i].t && currentT <= kfs[i + 1].t) {
            kf1 = kfs[i];
            kf2 = kfs[i + 1];
            break;
        }
    }
    // 0.0001 = epsilon kecil untuk mencegah pembagian nol
    let p = (currentT - kf1.t) / (kf2.t - kf1.t + 0.0001);
    p = applyEase(p, kf2.ease);
    return kf1.val + (kf2.val - kf1.val) * p;
}

// Interpolasi keyframe untuk nilai vektor 2D (x, y)
function evalPropVec2(kfs, currentT) {
    if (!kfs || kfs.length === 0) return { x: 1, y: 1 };
    if (kfs.length === 1) return kfs[0].val;
    if (currentT <= kfs[0].t) return kfs[0].val;
    if (currentT >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].val;

    let kf1 = kfs[0], kf2 = kfs[kfs.length - 1];
    for (let i = 0; i < kfs.length - 1; i++) {
        if (currentT >= kfs[i].t && currentT <= kfs[i + 1].t) {
            kf1 = kfs[i];
            kf2 = kfs[i + 1];
            break;
        }
    }
    // 0.0001 = epsilon kecil untuk mencegah pembagian nol
    let p = (currentT - kf1.t) / (kf2.t - kf1.t + 0.0001);
    p = applyEase(p, kf2.ease);
    return {
        x: kf1.val.x + (kf2.val.x - kf1.val.x) * p,
        y: kf1.val.y + (kf2.val.y - kf1.val.y) * p
    };
}

function parseVec3(str) {
    const parts = str.split(',').map(parseFloat);
    return { x: parts[0], y: parts[1], z: parts[2] };
}
function parseVec2(str) {
    const parts = str.split(',').map(parseFloat);
    return { x: parts[0], y: parts[1] };
}

function createMediaSlot(uri, labelStr) {
    const div = document.createElement('div');
    div.className = 'media-slot';

    const label = document.createElement('div');
    label.className = 'slot-label';
    label.textContent = `Upload ${labelStr}`;

    const img = document.createElement('img');
    img.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';

    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const objectUrl = URL.createObjectURL(file);
            img.src = objectUrl;
            img.onload = () => {
                img.style.display = 'block';
                label.textContent = labelStr;

                // Save native HTMLImageElement instead of PIXI.Texture
                state.userMedia[uri] = img;
                checkReadyState();
                renderFrame(state.currentTime);
            };
        }
    });

    div.appendChild(img);
    div.appendChild(label);
    div.appendChild(input);
    UI.slotsContainer.appendChild(div);

    // Auto-load dummy image for debugging
    setTimeout(() => {
        img.src = 'pict_exp/daniele-colucci-kIZvTPUlMIY-unsplash.jpg';
        img.onload = () => {
            img.style.display = 'block';
            label.textContent = labelStr;
            state.userMedia[uri] = img;
            checkReadyState();
            renderFrame(state.currentTime);
        };
    }, 100);
}

function checkReadyState() {
    // Enable export if at least one photo is uploaded
    if (Object.keys(state.userMedia).length > 0) {
        UI.btnExport.disabled = false;
    }
}

// Audio Handling
UI.audioInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        // Tutup AudioContext lama agar tidak menumpuk di memori
        if (state.audioCtx) {
            state.audioCtx.close();
        }
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await file.arrayBuffer();
        state.audioBuffer = await state.audioCtx.decodeAudioData(arrayBuffer);
    }
});

// Helper untuk konversi warna ARGB dari Alight Motion ke RGBA Canvas
function amColorToRgba(amHex) {
    if (!amHex || amHex.length !== 9) return amHex;
    const a = parseInt(amHex.substr(1, 2), 16) / 255;
    const r = parseInt(amHex.substr(3, 2), 16);
    const g = parseInt(amHex.substr(5, 2), 16);
    const b = parseInt(amHex.substr(7, 2), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Render Engine
function renderFrame(timeMs) {
    const timeSec = timeMs / 1000.0;
    
    // Clear Canvas with Black Background
    UI.ctx.fillStyle = '#000000';
    UI.ctx.fillRect(0, 0, state.width, state.height);

    state.shapes.forEach((shape, index) => {
        const isColor = shape.fillType === 'color';
        const imgLoaded = state.userMedia[shape.fillImage];
        
        if (!isColor && !imgLoaded) {
            return; // Wait for user to upload media
        }

        if (timeMs >= shape.startTime && timeMs <= shape.endTime) {
            const duration = shape.endTime - shape.startTime;
            const localTimeRatio = duration === 0 ? 0 : (timeMs - shape.startTime) / duration;
            let effectTime = (timeMs - shape.startTime) / 1000.0;

            // Base Opacity
            let opacity = 1.0;
            if (shape.opacityKfs && shape.opacityKfs.length > 0) {
                opacity = evalProp(shape.opacityKfs, localTimeRatio);
            }

            // Base Rotation
            let baseRot = 0;
            if (shape.rotKfs && shape.rotKfs.length > 0) {
                baseRot = evalProp(shape.rotKfs, localTimeRatio) * (Math.PI / 180);
            }

            // Base Scale
            const scaleVal = evalPropVec2(shape.scaleKfs, localTimeRatio);
            let scaleX = scaleVal.x, scaleY = scaleVal.y;

            // Calculate Base Scale to Fill Shape Size (or Canvas)
            let baseScaleX = 1, baseScaleY = 1;
            let targetW = shape.shapeSizeX || state.width;
            let targetH = shape.shapeSizeY || state.height;

            if (!isColor && imgLoaded) {
                // 'mediaFillMode' logic: "fill" means COVER the canvas
                const scale = Math.max(targetW / imgLoaded.naturalWidth, targetH / imgLoaded.naturalHeight);
                baseScaleX = scale;
                baseScaleY = scale;
            }

            // Apply embedScene scale
            baseScaleX *= (shape.embedScaleX !== undefined ? shape.embedScaleX : 1.0);
            baseScaleY *= (shape.embedScaleY !== undefined ? shape.embedScaleY : 1.0);

            // Base Location
            let offsetX = state.width / 2, offsetY = state.height / 2;
            if (shape.locKfs && shape.locKfs.length > 0) {
                const locVal = evalPropVec2(shape.locKfs, localTimeRatio);
                offsetX = locVal.x;
                offsetY = locVal.y;
            }

            // Apply embedScene offsets
            offsetX += (shape.embedOffsetX || 0);
            offsetY += (shape.embedOffsetY || 0);

            // Swing
            let swingEff = shape.effects.find(e => e.id === 'com.alightcreative.effects.swing2' || e.id === 'com.alightcreative.effects.swing');
            if (swingEff) {
                let freq = evalProp(swingEff.props['freq'], localTimeRatio);
                let a1 = evalProp(swingEff.props['a1'], localTimeRatio);
                let a2 = evalProp(swingEff.props['a2'], localTimeRatio);
                let phase = evalProp(swingEff.props['phase'], localTimeRatio);
                let osc = Math.sin(effectTime * Math.PI * 2 * freq + phase * Math.PI * 2);
                let angleDeg = osc > 0 ? (osc * a2) : (osc * Math.abs(a1));
                baseRot += angleDeg * (Math.PI / 180);
            }

            // Oscillate & Shake
            let oscEffs = shape.effects.filter(e => e.id === 'com.alightcreative.effects.oscillate3' || e.id === 'com.alightcreative.effects.oscillate' || e.id === 'com.alightcreative.effects.shake2');
            oscEffs.forEach(oscEff => {
                let freq = evalProp(oscEff.props['freq'], localTimeRatio);
                let mag = evalProp(oscEff.props['mag'], localTimeRatio);
                let angle = evalProp(oscEff.props['angle'], localTimeRatio);
                let phase = evalProp(oscEff.props['phase'] || [{ t: 0, val: 0 }], localTimeRatio);
                let isShake = oscEff.id === 'com.alightcreative.effects.shake2';
                let phaseOffset = isShake ? 0.25 : 0; 
                let osc = Math.sin(effectTime * Math.PI * 2 * freq + (phase + phaseOffset) * Math.PI * 2);

                offsetX += Math.cos(angle * Math.PI / 180) * osc * mag * 2.0;
                offsetY -= Math.sin(angle * Math.PI / 180) * osc * mag * 2.0;
            });

            // Filters for Canvas 2D
            let cssFilters = [];
            
            let blurEff = shape.effects.find(e => e.id === 'com.alightcreative.effects.gaussianblur');
            if (blurEff) {
                let strength = evalProp(blurEff.props['strength'], localTimeRatio);
                if (strength > 0) cssFilters.push(`blur(${strength * 50}px)`);
            }

            let expEff = shape.effects.find(e => e.id === 'com.alightcreative.effects.exposure');
            if (expEff) {
                let exp = evalProp(expEff.props['exposure'], localTimeRatio);
                if (exp > 0) cssFilters.push(`brightness(${1 + exp})`);
            }

            // Draw to Canvas
            UI.ctx.save();
            
            // Set Alpha and Filters
            UI.ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
            if (cssFilters.length > 0) {
                UI.ctx.filter = cssFilters.join(' ');
            }

            // Apply Transforms
            UI.ctx.translate(offsetX, offsetY);
            UI.ctx.rotate(baseRot);
            UI.ctx.scale(baseScaleX * scaleX, baseScaleY * scaleY);

            // Wipe Effect (Simulasi dengan Clipping Path)
            let wipeEff = shape.effects.find(e => e.id === 'com.alightcreative.effects.wipe2');
            if (wipeEff) {
                let start = evalProp(wipeEff.props['start'], localTimeRatio);
                let end = evalProp(wipeEff.props['end'], localTimeRatio);
                let angle = evalProp(wipeEff.props['angle'], localTimeRatio);
                
                // Gunakan bounding box yang sangat besar agar menutupi gambar apa pun
                const maxDim = Math.max(targetW, targetH) * 3;
                
                // Menentukan koordinat pemotongan berdasarkan start/end (0 hingga 1)
                // Default wipe bergerak dari atas ke bawah. Nilai 0 = atas, 1 = bawah
                const startY = (start - 0.5) * targetH;
                const endY = (end - 0.5) * targetH;

                UI.ctx.rotate((angle - 90) * Math.PI / 180);
                UI.ctx.beginPath();
                UI.ctx.rect(-maxDim/2, startY, maxDim, endY - startY);
                UI.ctx.clip();
                UI.ctx.rotate(-(angle - 90) * Math.PI / 180);
            }

            // Draw content
            if (isColor && shape.fillColor) {
                UI.ctx.fillStyle = amColorToRgba(shape.fillColor);
                UI.ctx.fillRect(-targetW/2, -targetH/2, targetW, targetH);
            } else if (imgLoaded) {
                UI.ctx.drawImage(imgLoaded, -imgLoaded.naturalWidth/2, -imgLoaded.naturalHeight/2, imgLoaded.naturalWidth, imgLoaded.naturalHeight);
            }

            UI.ctx.restore();


        }
    });

    // Update UI
    UI.progressBar.value = timeMs;
    UI.currentTimeLabel.textContent = formatTime(timeMs);
}

function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const s = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

// Playback Loop
function loop() {
    if (!state.isPlaying) return;

    const now = performance.now();
    let elapsed = now - state.startTimeRaw;

    if (elapsed > state.totalTime) {
        state.isPlaying = false;
        UI.btnPlayPause.textContent = 'Play';
        elapsed = state.totalTime;
        if (state.audioSource) {
            state.audioSource.stop();
            state.audioSource = null;
        }
    }

    state.currentTime = elapsed;
    renderFrame(state.currentTime);

    if (state.isPlaying) {
        requestAnimationFrame(loop);
    }
}

UI.btnPlayPause.addEventListener('click', () => {
    if (state.isPlaying) {
        state.isPlaying = false;
        UI.btnPlayPause.textContent = 'Play';
        if (state.audioSource) {
            state.audioSource.stop();
            state.audioSource = null;
        }
    } else {
        state.isPlaying = true;
        UI.btnPlayPause.textContent = 'Pause';

        // Sync Audio
        if (state.audioBuffer && state.audioCtx) {
            if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
            state.audioSource = state.audioCtx.createBufferSource();
            state.audioSource.buffer = state.audioBuffer;
            state.audioSource.connect(state.audioCtx.destination);

            // If exporting, we connect to stream destination
            // state.audioSource.start(0, state.currentTime / 1000);
            state.audioSource.start(0, state.currentTime / 1000);
        }

        state.startTimeRaw = performance.now() - state.currentTime;
        requestAnimationFrame(loop);
    }
});

UI.progressBar.addEventListener('input', (e) => {
    state.currentTime = parseFloat(e.target.value);
    renderFrame(state.currentTime);
    if (state.isPlaying) {
        state.startTimeRaw = performance.now() - state.currentTime;
        if (state.audioSource) {
            state.audioSource.stop();
            state.audioSource = state.audioCtx.createBufferSource();
            state.audioSource.buffer = state.audioBuffer;
            state.audioSource.connect(state.audioCtx.destination);
            state.audioSource.start(0, state.currentTime / 1000);
        }
    }
});

// Video Export
UI.btnExport.addEventListener('click', async () => {
    if (state.isPlaying) {
        UI.btnPlayPause.click(); // Pause first
    }

    UI.renderStatus.classList.remove('hidden');
    UI.btnExport.disabled = true;
    UI.btnPlayPause.disabled = true;

    const stream = UI.canvas.captureStream(state.fps);

    // Mix audio if available
    let audioDest;
    if (state.audioBuffer && state.audioCtx) {
        audioDest = state.audioCtx.createMediaStreamDestination();
        const exportAudioSource = state.audioCtx.createBufferSource();
        exportAudioSource.buffer = state.audioBuffer;
        exportAudioSource.connect(audioDest);
        exportAudioSource.start();
        stream.addTrack(audioDest.stream.getAudioTracks()[0]);
    }

    state.mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
    state.recordedChunks = [];

    state.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) state.recordedChunks.push(e.data);
    };

    state.mediaRecorder.onstop = () => {
        const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'AlightEdit_Export.webm';
        a.click();
        URL.revokeObjectURL(url);

        UI.renderStatus.classList.add('hidden');
        UI.btnExport.disabled = false;
        UI.btnPlayPause.disabled = false;
    };

    state.mediaRecorder.start();

    // Simulate real-time rendering for the length of total time
    state.currentTime = 0;

    const renderLoop = setInterval(() => {
        state.currentTime += (1000 / state.fps);
        if (state.currentTime >= state.totalTime) {
            clearInterval(renderLoop);
            state.currentTime = state.totalTime;
            renderFrame(state.currentTime);
            state.mediaRecorder.stop();
            UI.renderProgress.textContent = "100%";
        } else {
            renderFrame(state.currentTime);
            const p = Math.floor((state.currentTime / state.totalTime) * 100);
            UI.renderProgress.textContent = `${p}%`;
        }
    }, 1000 / state.fps);
});

// Initialize App
// Canvas context is retrieved in UI object

// Start app
loadTemplate('template.xml');

// Handle Template Selection
const templateSelect = document.getElementById('templateSelect');
if (templateSelect) {
    templateSelect.addEventListener('change', (e) => {
        loadTemplate(e.target.value);
    });
}
