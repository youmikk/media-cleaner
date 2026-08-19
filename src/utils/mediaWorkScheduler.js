import { AppState } from 'react-native';

// MediaLibrary, PhotoKit/MediaStore size queries and native image decoding
// ultimately contend for the same platform media services. Keep background
// units serialized and always let user-visible work jump ahead between units.
// Callers must keep each unit bounded; native work already in flight cannot be
// pre-empted by JavaScript.
const queues = {
  interactive: [],
  background: [],
};

let running = false;
let appActive = !['background', 'inactive'].includes(AppState.currentState);

function drain() {
  if (running) return;
  const job =
    queues.interactive.shift() ||
    (appActive ? queues.background.shift() : null);
  if (!job) return;
  running = true;
  Promise.resolve()
    .then(job.work)
    .then(job.resolve, job.reject)
    .finally(() => {
      running = false;
      drain();
    });
}

AppState.addEventListener('change', (state) => {
  appActive = state === 'active';
  if (appActive) drain();
});

export function runMediaWork(work, priority = 'interactive') {
  const queue = priority === 'background' ? queues.background : queues.interactive;
  return new Promise((resolve, reject) => {
    queue.push({ work, resolve, reject });
    drain();
  });
}

export function pendingMediaWork() {
  return {
    running,
    interactive: queues.interactive.length,
    background: queues.background.length,
  };
}
