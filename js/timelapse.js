// The agentic timelapse video wears the viewer cards' timeline: play / pause,
// an accent slider with one step per video frame, and an "n / N" counter, so
// the iterations can be scrolled back through. The <video> states its frame
// rate and frame count (data-fps, data-frames: the WebM container rounds its
// duration up, so the count is not derived from it). Scrubbing stops the
// loop, like on the cards; the play button resumes it. Seeking needs a server
// that answers byte ranges (GitHub Pages does; locally use scripts/serve.py).

function mountTimelapse(clip) {
  const video = clip.querySelector('video');
  const play = clip.querySelector('.viewer-play');
  const slider = clip.querySelector('.viewer-slider');
  const count = clip.querySelector('.viewer-count');
  const fps = Number(video.dataset.fps) || 30;
  const frames = Math.max(1, Number(video.dataset.frames) || 1);
  slider.max = frames - 1;

  const frameAt = time => Math.min(frames - 1, Math.floor(time * fps + 1e-6));

  function reflect() {
    const frame = frameAt(video.currentTime);
    slider.value = frame;
    count.textContent =
      `${String(frame + 1).padStart(String(frames).length, ' ')} / ${frames}`;
    clip.classList.toggle('is-playing', !video.paused && !video.ended);
  }
  reflect();

  // Seek to the middle of a frame so the browser shows that frame, not the
  // one before it.
  slider.addEventListener('input', () => {
    video.pause();
    video.currentTime = (Number(slider.value) + 0.5) / fps;
    reflect();
  });
  play.addEventListener('click', () => { video.paused ? video.play() : video.pause(); });
  video.addEventListener('click', () => { video.paused ? video.play() : video.pause(); });
  for (const event of ['play', 'pause', 'seeked', 'timeupdate', 'ended']) {
    video.addEventListener(event, reflect);
  }
  // timeupdate fires only a few times a second; follow playback per frame.
  (function tick() {
    if (!video.paused) reflect();
    requestAnimationFrame(tick);
  })();
}

document.querySelectorAll('.timelapse-clip').forEach(mountTimelapse);
