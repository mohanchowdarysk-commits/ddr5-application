// Load a bundled third-party script (from ./vendor) once, on demand.
const pending = new Map();

export function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!pending.has(src)) {
    pending.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${src} did not load`)));
      s.onerror = () => {
        pending.delete(src);
        s.remove();
        reject(new Error(`Could not load ${src}`));
      };
      document.head.appendChild(s);
    }));
  }
  return pending.get(src);
}
