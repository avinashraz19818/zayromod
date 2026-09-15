import { build } from './builder.js';
process.once('message', ({ config, job }) => {
  try {
    const result = build(config, job, (message, progress) => process.send({ type: 'progress', message, progress }));
    process.send({ type: 'result', result }, () => process.exit(0));
  } catch (error) { process.send({ type: 'failure', message: error.message }, () => process.exit(1)); }
});
