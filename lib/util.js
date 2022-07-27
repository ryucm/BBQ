import winston from "winston";
import annotate from "winston-annotate";

export function range(start, end, step) {
  const _end = end || start;
  const _start = end ? start : 0;
  const _step = step || 1;
  return Array((_end - _start) / _step).fill(0).map((v, i) => _start + (i * _step));
}

export const logger = winston.createLogger({
  transports: [
    new (winston.transports.Console)({
      level: 'debug',
      colorize: true,
      timestamp: true,
    }),
    new (winston.transports.File)({
      level: 'debug',
      colorize: true,
      timestamp: true,
      filename: './log/wagyu.log',
      json: false,
    }),
  ],
});

export const annotateLogger = name => annotate(logger, `[${name}]`);