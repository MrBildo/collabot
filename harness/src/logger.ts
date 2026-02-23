import pino from 'pino';

export const verbose = process.env.HARNESS_VERBOSE === 'true' || process.argv.includes('--verbose');
export const logger = pino({ level: verbose ? 'debug' : 'info' }, pino.destination({ sync: true }));
