import pino from 'pino';

const verbose = process.env.HARNESS_VERBOSE === 'true';
export const logger = pino({ level: verbose ? 'debug' : 'info' }, pino.destination({ sync: true }));
