// An examples carousel: native scroll-snap for swiping, arrows + dots for
// pointers, and exactly one live viewer on the whole page at a time (see
// Stage in viewer.js). Slides are stamped from the <template> in index.html
// using <assets>/index.json, which the bake writes.
//
// The page mounts one carousel per dataset section: every `.carousel` with a
// `data-assets` attribute pointing at its baked directory.
import { ArcticViewer } from './viewer.js';

export async function mountCarousel(carousel) {
  const assets = carousel.dataset.assets.replace(/\/?$/, '/');
  const track = carousel.querySelector('.carousel-track');
  const dots = carousel.querySelector('.carousel-dots');
  const note = carousel.querySelector('.carousel-note');
  const template = document.getElementById('viewer-template');

  // The example list changes with every rebake; revalidate it rather than
  // trusting a cached copy (GitHub Pages serves it with max-age=600).
  const response = await fetch(assets + 'index.json', { cache: 'no-cache' });
  if (!response.ok) {
    note.textContent =
      `Viewer assets are not built yet (${assets}index.json missing).`;
    return;
  }
  const { examples } = await response.json();

  const slides = examples.map((example, index) => {
    const slide = template.content.firstElementChild.cloneNode(true);
    const base = assets + example.id + '/';
    slide.dataset.index = index;
    // Per-carousel card variant (e.g. data-panel="bottom-right"), see viewer.css.
    if (carousel.dataset.panel) slide.dataset.panel = carousel.dataset.panel;
    // data-camera="follow": the 3D view opens (and resets) as the capture camera.
    if (carousel.dataset.camera) slide.dataset.camera = carousel.dataset.camera;
    // data-grid="none": no floor grid in the 3D view.
    if (carousel.dataset.grid) slide.dataset.grid = carousel.dataset.grid;
    // data-controls="trackball": free rotation instead of the up-locked orbit.
    if (carousel.dataset.controls) slide.dataset.controls = carousel.dataset.controls;
    slide.querySelector('.viewer-title').textContent = example.title;
    slide.querySelector('.viewer-source').textContent = example.subtitle
      ?? `ARCTIC ${example.source?.sub ?? ''} / ${example.source?.seq ?? ''}`;
    slide.querySelector('.viewer-poster').style.backgroundImage =
      `url(${base + example.poster})`;
    track.appendChild(slide);

    // Navigation: a thumbnail per example (scripts/make_thumbs.py: the first
    // frame, with our parts drawn in for the wild cards), or a plain dot when
    // none is baked.
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Example ${index + 1}: ${example.title}`);
    dot.title = example.title;
    if (example.thumb) {
      const thumb = document.createElement('img');
      thumb.src = base + example.thumb;
      thumb.alt = '';
      thumb.width = 56;
      thumb.height = 56;
      thumb.loading = 'lazy';
      dot.appendChild(thumb);
      dot.classList.add('thumb');
    }
    dot.addEventListener('click', () => scrollToSlide(index));
    dots.appendChild(dot);

    const viewer = new ArcticViewer(slide, base);
    slide.querySelector('.viewer-poster').addEventListener(
      'click', () => activate(index));
    // A fullscreen card is position:fixed, so it leaves the scroll track and
    // a neighbour would "come into view" and steal the live renderer. Freeze
    // slide switching while any card is fullscreen, and re-snap afterwards.
    viewer.onFullscreenChange = on => {
      fullscreenLock = on;
      if (!on) scrollToSlide(current);
    };
    return { slide, viewer, dot };
  });

  let current = -1;
  let fullscreenLock = false;
  function activate(index) {
    if (fullscreenLock) return;
    // Re-activating the current slide is how a carousel takes the shared
    // renderer back after another carousel on the page borrowed it.
    if (index === current && slides[index].viewer.isLive()) return;
    if (current >= 0 && current !== index) slides[current].viewer.deactivate();
    current = index;
    slides.forEach(({ dot }, i) => dot.classList.toggle('active', i === index));
    carousel.querySelector('.carousel-counter').textContent =
      `${index + 1} / ${slides.length}`;
    const { viewer } = slides[index];
    viewer.activate().then(() => {
      // Warm the next slide's geometry so swiping there feels instant.
      slides[(index + 1) % slides.length].viewer.load().catch(() => {});
    });
  }

  function scrollToSlide(index) {
    const target = slides[(index + slides.length) % slides.length].slide;
    track.scrollTo({ left: target.offsetLeft, behavior: 'smooth' });
  }

  carousel.querySelector('.carousel-prev').addEventListener(
    'click', () => scrollToSlide(current - 1));
  carousel.querySelector('.carousel-next').addEventListener(
    'click', () => scrollToSlide(current + 1));

  // Whichever slide is (mostly) in view of the TRACK is the live one. This
  // observer is rooted on the track, so it also fires at mount time for slide
  // 0 whether or not the carousel is on screen: it must never start a
  // carousel (the page-level arbiter does), only follow swipes in one that is.
  const observer = new IntersectionObserver(entries => {
    if (current < 0) return;
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
        activate(Number(entry.target.dataset.index));
      }
    }
  }, { root: track, threshold: [0.6] });
  slides.forEach(({ slide }) => observer.observe(slide));

  return {
    element: carousel,
    isLive: () => current >= 0 && slides[current].viewer.isLive(),
    // Go (back) live on the slide the visitor left this carousel at.
    resume: () => activate(current < 0 ? 0 : current),
  };
}

// One renderer, several carousels: the most visible carousel owns it. This
// starts the first one only once the visitor scrolls to it (the page above
// loads instantly, no WebGL work off-screen) and hands the renderer back and
// forth as they move between sections. Ties go to the earlier section.
function arbitrate(handles) {
  const byElement = new Map(handles.map(handle => [handle.element, handle]));
  const ratios = new Map();
  const pick = () => {
    let best = null;
    for (const handle of handles) {
      const ratio = ratios.get(handle) ?? 0;
      if (ratio >= 0.5 && (!best || ratio > ratios.get(best))) best = handle;
    }
    if (best && !best.isLive()) best.resume();
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      ratios.set(byElement.get(entry.target),
        entry.isIntersecting ? entry.intersectionRatio : 0);
    }
    pick();
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  handles.forEach(handle => observer.observe(handle.element));
}

async function main() {
  const carousels = [...document.querySelectorAll('.carousel[data-assets]')];
  const handles = await Promise.all(carousels.map(
    carousel => mountCarousel(carousel).catch(error => {
      console.error(error);
      carousel.querySelector('.carousel-note').textContent = error.message;
      return null;
    })));
  arbitrate(handles.filter(Boolean));
}

main();
