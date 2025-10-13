const
    el = {},
    usingOffscreenCanvas = isOffscreenCanvasWorking();

document
    .querySelectorAll('[id]')
    .forEach(element => el[element.id] = element)

// map the viewport (it's a class, not an id)
el.viewport = document.querySelector('.viewport') || el.viewport

// Simple viewport state machine so UI toggles are deterministic:
// 'hidden'  - nothing visible
// 'streaming' - live camera + canvas visible
// 'captured' - captured image visible (result of successful scan or uploaded image)
let appState = 'hidden'

function showViewport(state = 'streaming') {
    try { if (el.viewport) el.viewport.classList.add('active') } catch (e) {}
    try { if (el.videoBtn) el.videoBtn.className = 'button-primary' } catch (e) {}
    appState = state
    try { console.debug && console.debug('showViewport ->', appState) } catch (e) {}
}

function hideViewport() {
    try { if (el.viewport) el.viewport.classList.remove('active') } catch (e) {}
    try { if (el.videoBtn) el.videoBtn.className = '' } catch (e) {}
    // ensure child media are hidden to avoid visual leftovers
    try { if (el.img) { el.img.style.display = 'none'; el.img.src = '' } } catch (e) {}
    try { if (el.canvas) el.canvas.style.display = 'none' } catch (e) {}
    try { if (el.video) el.video.style.display = 'none' } catch (e) {}
    appState = 'hidden'
    try { console.debug && console.debug('hideViewport ->', appState) } catch (e) {}
}


let
    offCanvas,
    afterPreviousCallFinished,
    requestId = null;

// track last decoded symbols for display
let lastSymbols = [];

el.usingOffscreenCanvas.innerText = usingOffscreenCanvas ? 'yes' : 'no'

try {
    if (el.canvas) el.canvas.style.display = 'none'
    if (el.img) el.img.style.display = 'none'
    if (el.video) el.video.style.display = 'none'
    hideViewport()
} catch (e) {}
function isOffscreenCanvasWorking() {
    try {
        return Boolean((new OffscreenCanvas(1, 1)).getContext('2d'))

    } catch {
        return false
    }
}


function tryShowSuccessBanner(symbols) {
    const banner = el.successBanner
    const textEl = el.successText

    if (!banner || !textEl) return

    const primary = symbols[0]
    const display = primary && (primary.rawValue || primary.data || primary.type) ? (primary.rawValue || primary.data || primary.type) : JSON.stringify(primary)

    textEl.innerText = `Decoded: ${display}`
    banner.style.display = 'block'
}

// Wait until the video element reports non-zero dimensions or timeout.
function waitForVideoReady(video, timeout = 2000) {
    return new Promise((resolve) => {
        if (!video) return resolve()

        const start = performance.now()

        function check() {
            if (video.videoWidth > 0 && video.videoHeight > 0) return resolve()
            if (performance.now() - start > timeout) return resolve()
            requestAnimationFrame(check)
        }

        check()
    })
}


// Resume scanning: start camera again and hide banner
function resumeCamera() {
    const banner = el.successBanner
    if (banner) banner.style.display = 'none'

    // Basic capability checks and friendly errors for iOS/Safari
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        el.result.innerText = 'Camera not supported on this device/browser.'
        return
    }

    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        el.result.innerText = 'Camera access requires HTTPS. Serve the page over HTTPS or use localhost.'
        return
    }

    // try to re-open camera
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } })
        .then(stream => {
            const video = el.video

            // Ensure video is muted and plays inline before assigning srcObject (helps iOS autoplay/permission)
            try { video.muted = true } catch (e) {}
            try { video.playsInline = true; video.setAttribute('playsinline', '') } catch (e) {}

            video.srcObject = stream
            el.videoBtn.className = 'button-primary'

            // Start detection only after the video actually starts playing to avoid
            // the mobile permission popup race where srcObject is set but playback
            // hasn't begun yet.
            let fallbackTimer = null

            function cleanupAndStart() {
                if (fallbackTimer) {
                    clearTimeout(fallbackTimer)
                    fallbackTimer = null
                }
                video.removeEventListener('loadedmetadata', onLoaded)
                video.removeEventListener('playing', onPlaying)

                // try to play (some browsers require explicit play call)
                try {
                    const p = video.play()
                    if (p && p.catch) p.catch(() => {})
                } catch (e) {
                    // ignore
                }

                // Hide any captured image and wait for the video to be ready
                try {
                    if (el.img) {
                        el.img.src = ''
                        el.img.style.display = 'none'
                    }
                } catch (e) {}

                // Wait for the video element to report valid dimensions before
                // showing the canvas to avoid a transient black area.
                try {
                    waitForVideoReady(video, 1500).then(() => {
                                try { showViewport('streaming') } catch (e) {}
                                try { if (el.canvas) el.canvas.style.display = 'block' } catch (e) {}
                                try { if (el.video) el.video.style.display = 'none' } catch (e) {}
                            detectVideo(true)
                        })
                } catch (e) {
                    if (el.canvas) el.canvas.style.display = 'block'
                    if (el.video) el.video.style.display = 'none'
                    detectVideo(true)
                }
            }

            function onLoaded() {
                // try to start playback; if it succeeds, we'll get 'playing'
                try {
                    const p = video.play()
                    if (p && p.then) {
                        p.then(() => {
                            cleanupAndStart()
                        }).catch(() => {
                            // wait for 'playing' event or fallback
                        })
                    } else {
                        cleanupAndStart()
                    }
                } catch (e) {
                    // fall through to waiting for 'playing'
                }
            }

            function onPlaying() {
                cleanupAndStart()
            }

            video.addEventListener('loadedmetadata', onLoaded)
            video.addEventListener('playing', onPlaying)

            // Fallback: if neither event fires within a short timeout, start anyway
            fallbackTimer = setTimeout(() => {
                cleanupAndStart()
            }, 1200)
        })
        .catch(err => {
            // show error in result if it fails
            el.result.innerText = JSON.stringify(err)
        })
}

// wire resume button if present
if (el.resumeBtn) {
    el.resumeBtn.addEventListener('click', resumeCamera)
}


function formatNumber(number, fractionDigits = 1) {
    return number.toLocaleString(
        undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }
    )
}


function detect(source) {
    const
        afterFunctionCalled = performance.now(),
        canvas = el.canvas,
        ctx = canvas.getContext('2d');

    function getOffCtx2d(width, height) {
        if (usingOffscreenCanvas) {
            if (!offCanvas || (offCanvas.width !== width) || (offCanvas.height !== height)) {
                // Only resizing the canvas caused Chromium to become progressively slower
                offCanvas = new OffscreenCanvas(width, height)
            }

            return offCanvas.getContext('2d')
        }
    }

    canvas.width = source.naturalWidth || source.videoWidth || source.width
    canvas.height = source.naturalHeight || source.videoHeight || source.height

    if (canvas.height && canvas.width) {
        const offCtx = getOffCtx2d(canvas.width, canvas.height) || ctx

        offCtx.drawImage(source, 0, 0)

        const
            afterDrawImage = performance.now(),
            imageData = offCtx.getImageData(0, 0, canvas.width, canvas.height),
            afterGetImageData = performance.now();

        return zbarWasm
            .scanImageData(imageData)
            .then(symbols => {
                const afterScanImageData = performance.now()

                // Ensure the visible canvas contains the image used for decoding.
                // This is necessary when OffscreenCanvas is used for scanning; the
                // visible canvas may not have the image drawn on it yet. Draw the
                // source onto the visible canvas first, then paint overlays.
                try {
                    ctx.clearRect(0, 0, canvas.width, canvas.height)
                    ctx.drawImage(source, 0, 0)
                } catch (e) {
                    // ignore if drawing fails for any reason
                }

                // Detect if symbol points are normalized (0..1) or in pixel coords
                let globalMaxX = -Infinity, globalMaxY = -Infinity
                symbols.forEach(sym => {
                    if (sym.points && Array.isArray(sym.points)) {
                        sym.points.forEach(p => {
                            if (typeof p.x === 'number' && typeof p.y === 'number') {
                                globalMaxX = Math.max(globalMaxX, p.x)
                                globalMaxY = Math.max(globalMaxY, p.y)
                            }
                        })
                    }
                })

                const pointsAreNormalized = (globalMaxX <= 1 && globalMaxY <= 1)

                symbols.forEach(symbol => {
                    if (!symbol.points || !symbol.points.length) return

                    // Scale points to canvas pixel coordinates if normalized
                    const pts = symbol.points.map(p => {
                        if (typeof p.x !== 'number' || typeof p.y !== 'number') return null
                        return {
                            x: pointsAreNormalized ? (p.x * canvas.width) : p.x,
                            y: pointsAreNormalized ? (p.y * canvas.height) : p.y
                        }
                    }).filter(Boolean)

                    if (!pts.length) return

                    // Draw polygon overlay
                    const lastPoint = pts[pts.length - 1]
                    ctx.beginPath()
                    ctx.moveTo(lastPoint.x, lastPoint.y)
                    pts.forEach(point => ctx.lineTo(point.x, point.y))

                    ctx.lineWidth = Math.max(Math.min(canvas.height, canvas.width) / 100, 1)
                    ctx.strokeStyle = '#00e00060'
                    ctx.stroke()

                    // Compute bounding box for the symbol points and draw a box
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
                    pts.forEach(p => {
                        minX = Math.min(minX, p.x)
                        minY = Math.min(minY, p.y)
                        maxX = Math.max(maxX, p.x)
                        maxY = Math.max(maxY, p.y)
                    })

                    if (isFinite(minX) && isFinite(minY) && maxX > minX && maxY > minY) {
                        const bw = Math.max(Math.min(canvas.height, canvas.width) / 120, 1.5)
                        ctx.lineWidth = bw
                        ctx.strokeStyle = '#00e000'
                        ctx.strokeRect(minX, minY, maxX - minX, maxY - minY)
                    }
                })

                symbols.forEach(s => s.rawValue = s.decode(el.encoding.value))

                if (!el.details.checked) {
                    symbols.forEach(s => {
                        delete s.type
                        delete s.data
                        delete s.points
                        delete s.time
                        delete s.cacheCount
                    })
                }

                el.result.innerText = JSON.stringify(symbols, null, 2)

                el.waitingTime.innerText = formatNumber(afterFunctionCalled - afterPreviousCallFinished)
                el.drawImageTime.innerText = formatNumber(afterDrawImage - afterFunctionCalled)
                el.getImageDataTime.innerText = formatNumber(afterGetImageData - afterDrawImage)
                el.scanImageDataTime.innerText = formatNumber(afterScanImageData - afterGetImageData)
                el.timing.className = 'visible'
                // If we decoded at least one symbol, decide whether to stop further scanning
                if (symbols && symbols.length > 0) {
                    // If quality fields are present, require best quality >= 10 to stop.
                    const qualities = symbols
                        .map(s => (s && typeof s.quality === 'number') ? s.quality : null)
                        .filter(q => q !== null)

                    if (qualities.length > 0) {
                        const best = Math.max(...qualities)
                        if (best < 10) {
                            // Low-quality decode: keep scanning. Update result and return.
                            el.result.innerText = JSON.stringify(symbols, null, 2) + `\n\nNote: best quality=${best} < 10 — continuing scan`;
                            // leave timing visible and do not stop video/animation
                            afterPreviousCallFinished = performance.now()
                            return
                        }
                    }
                    lastSymbols = symbols

                    // show success banner with the first decoded value
                    tryShowSuccessBanner(symbols)
                    // capture the canvas (with overlays) and show it as an image
                    try {
                        // Determine bounding box around all symbol points using the
                        // same scaled pixel coordinates we used to draw overlays.
                        const allPts = []
                        symbols.forEach(sym => {
                            if (sym.points && Array.isArray(sym.points)) {
                                sym.points.forEach(p => {
                                    if (typeof p.x === 'number' && typeof p.y === 'number') {
                                        const sx = (globalMaxX <= 1 && globalMaxY <= 1) ? (p.x * canvas.width) : p.x
                                        const sy = (globalMaxX <= 1 && globalMaxY <= 1) ? (p.y * canvas.height) : p.y
                                        allPts.push({ x: sx, y: sy })
                                    }
                                })
                            }
                        })

                        let dataUrl

                        if (allPts.length > 0) {
                            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
                            allPts.forEach(p => {
                                minX = Math.min(minX, p.x)
                                minY = Math.min(minY, p.y)
                                maxX = Math.max(maxX, p.x)
                                maxY = Math.max(maxY, p.y)
                            })

                            if (!(minX !== Infinity && isFinite(minX) && maxX > minX && maxY > minY)) {
                                // fallback
                                dataUrl = canvas.toDataURL('image/png')
                            } else {
                                // Add 20% margin around the box
                                const boxW = maxX - minX
                                const boxH = maxY - minY
                                const marginX = boxW * 0.2
                                const marginY = boxH * 0.2

                                let sx = Math.max(0, Math.floor(minX - marginX))
                                let sy = Math.max(0, Math.floor(minY - marginY))
                                let sw = Math.min(canvas.width - sx, Math.ceil((maxX + marginX) - sx))
                                let sh = Math.min(canvas.height - sy, Math.ceil((maxY + marginY) - sy))

                                // Fallback to full canvas if computed box is tiny or invalid
                                if (sw <= 0 || sh <= 0 || sw < 4 || sh < 4) {
                                    dataUrl = canvas.toDataURL('image/png')
                                } else {
                                    const tmp = document.createElement('canvas')
                                    tmp.width = sw
                                    tmp.height = sh
                                    const tctx = tmp.getContext('2d', { willReadFrequently: true })
                                    tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
                                    dataUrl = tmp.toDataURL('image/png')
                                }
                            }
                        } else {
                            // No valid points: fallback to full-canvas capture
                            dataUrl = canvas.toDataURL('image/png')
                        }

                        if (el.img) {
                            el.img.src = dataUrl
                            el.img.style.display = 'block'
                            el.img.style.width = '100%'
                        }

                        // hide the live canvas to show the captured image clearly
                        if (el.canvas) el.canvas.style.display = 'none'
                        if (el.video) el.video.style.display = 'none'
                        // mark state as captured and ensure viewport shows
                        try { showViewport('captured') } catch (e) {}
                    } catch (e) {
                        // ignore capture errors
                        try {
                            const fallback = canvas.toDataURL('image/png')
                            if (el.img) {
                                el.img.src = fallback
                                el.img.style.display = 'block'
                                el.img.style.width = '100%'
                            }
                            if (el.canvas) el.canvas.style.display = 'none'
                            if (el.video) el.video.style.display = 'none'
                                try { showViewport('captured') } catch (e) {}
                        } catch (e2) {
                            // give up
                        }
                    }
                    // stop video stream if active
                    if (el.video && el.video.srcObject) {
                        try {
                            el.video.srcObject.getTracks().forEach(track => track.stop())
                        } catch (e) {
                            // ignore
                        }
                        el.video.srcObject = null
                    }

                    // cancel any pending animation frame
                    if (requestId) {
                        cancelAnimationFrame(requestId)
                        requestId = null
                    }

                    // update video button state: keep it active while viewport is visible
                    // (we use the button as a two-state indicator; showViewport()/hideViewport() manages it)
                }

                afterPreviousCallFinished = performance.now()
            })

    } else {
        // If the source is a video element with an active stream, metadata
        // (videoWidth/videoHeight) may not be available yet. In that case we
        // should not overwrite the previous result with 'Source not ready' —
        // just return and let the next animation frame retry.
        try {
            if (source && source.tagName && source.tagName.toLowerCase() === 'video' && source.srcObject) {
                // keep previous el.result content and timing; don't change UI
                return Promise.resolve()
            }
        } catch (e) {
            // ignore and fallthrough to show message
        }

        el.result.innerText = 'Source not ready'
        el.timing.className = ''

        return Promise.resolve()
    }
}


function detectImg() {
    detectVideo(false)

    if (el.video.srcObject) {
        el.video.srcObject.getTracks().forEach(track => track.stop())
        el.video.srcObject = null
    }

    // FF needs some time to properly update decode()
    setTimeout(() => el.img.decode().then(() => detect(el.img)), 100)
}


function detectVideo(active) {
    if (active) {
        // ensure only canvas is visible while scanning
        try {
                if (el.viewport) showViewport()
            if (el.canvas) el.canvas.style.display = 'block'
            if (el.video) el.video.style.display = 'none'
            if (el.img) el.img.style.display = 'none'
        } catch (e) {}
        detect(el.video)
            .then(() => {
                // Only schedule the next frame if the video stream is still active.
                if (el.video && el.video.srcObject) {
                    requestId = requestAnimationFrame(() => detectVideo(true))
                } else {
                    requestId = null
                }
            })

    } else {
        cancelAnimationFrame(requestId)
        requestId = null
        // hide canvas when stopping scanning
        try { if (el.canvas) el.canvas.style.display = 'none' } catch (e) {}
    }
}


function onUrlActive() {
        if (el.imgUrl.validity.valid) {
        el.imgBtn.className = ''
        hideViewport()
        el.imgUrl.className = 'active'

        el.img.src = el.imgUrl.value
        try {
                if (el.viewport) showViewport('captured')
            if (el.img) el.img.style.display = 'block'
            if (el.canvas) el.canvas.style.display = 'none'
            if (el.video) el.video.style.display = 'none'
        } catch (e) {}
        detectImg()
    }
}

el.imgUrl.addEventListener('change', onUrlActive)
el.imgUrl.addEventListener('focus', onUrlActive)


el.fileInput.addEventListener('change', event => {
    el.imgUrl.className = ''
    // keep only videoBtn as the primary indicator for viewport state

    el.img.src = URL.createObjectURL(el.fileInput.files[0])
    try {
        if (el.viewport) showViewport('captured')
        if (el.img) el.img.style.display = 'block'
        if (el.canvas) el.canvas.style.display = 'none'
        if (el.video) el.video.style.display = 'none'
    } catch (e) {}
    el.fileInput.value = null
    detectImg()
})


el.imgBtn.addEventListener('click', event => {
    el.fileInput.dispatchEvent(new MouseEvent('click'))
})


el.videoBtn.addEventListener('click', event => {
    // Deterministic three-state behavior driven by appState
    if (appState === 'streaming') {
        // stop camera and hide everything
        el.imgUrl.className = el.imgBtn.className = el.videoBtn.className = ''
        detectVideo(false)
        try {
            if (el.video && el.video.srcObject) {
                el.video.srcObject.getTracks().forEach(t => t.stop())
                el.video.srcObject = null
            }
        } catch (e) {}
        try { if (el.canvas) el.canvas.style.display = 'none' } catch (e) {}
        try { if (el.video) el.video.style.display = 'none' } catch (e) {}
        try { hideViewport() } catch (e) {}
        return
    }

    if (appState === 'captured') {
        // Hide captured image and viewport
        el.imgUrl.className = ''
        el.imgBtn.className = ''
        try { if (el.img) { el.img.style.display = 'none'; el.img.src = '' } } catch (e) {}
        try { if (el.canvas) el.canvas.style.display = 'none' } catch (e) {}
        try { if (el.video) el.video.style.display = 'none' } catch (e) {}
        try { hideViewport() } catch (e) {}
        return
    }

    // appState === 'hidden' -> start camera
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        el.result.innerText = 'Camera not supported on this device/browser.'
        return
    }

    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        el.result.innerText = 'Camera access requires HTTPS. Serve the page over HTTPS or use localhost.'
        return
    }

    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } })
        .then(stream => {
            el.imgUrl.className = el.imgBtn.className = ''
            el.videoBtn.className = 'button-primary'

            const video = el.video
            // Ensure muted/playsinline before assigning srcObject (helps iOS)
            try { video.muted = true } catch (e) {}
            try { video.playsInline = true; video.setAttribute('playsinline', '') } catch (e) {}
            video.srcObject = stream

            let fallbackTimer = null

            function cleanupAndStart() {
                if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null }
                video.removeEventListener('loadedmetadata', onLoaded)
                video.removeEventListener('playing', onPlaying)

                try {
                    const p = video.play()
                    if (p && p.catch) p.catch(() => {})
                } catch (e) {}

                try {
                    if (el.img) {
                        el.img.src = ''
                        el.img.style.display = 'none'
                    }
                    if (el.canvas) el.canvas.style.display = 'block'
                    if (el.video) el.video.style.display = 'none'
                    try { showViewport('streaming') } catch (e) {}
                } catch (e) {}

                detectVideo(true)
            }

            function onLoaded() {
                try {
                    const p = video.play()
                    if (p && p.then) {
                        p.then(() => cleanupAndStart()).catch(() => {})
                    } else {
                        cleanupAndStart()
                    }
                } catch (e) {}
            }

            function onPlaying() { cleanupAndStart() }

            video.addEventListener('loadedmetadata', onLoaded)
            video.addEventListener('playing', onPlaying)

            fallbackTimer = setTimeout(() => cleanupAndStart(), 1200)
        })
        .catch(error => {
            el.result.innerText = JSON.stringify(error)
            el.timing.className = ''
            console.warn('getUserMedia error (videoBtn):', error)
        })
})
