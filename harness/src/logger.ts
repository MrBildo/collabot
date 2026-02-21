import pino from 'pino';

export const logger = pino({ level: 'debug' }, pino.destination({ sync: true }));
