

export function range(start, end, step) {
  const _end = end || start;
  const _start = end ? start : 0;
  const _step = step || 1;
  return Array((_end - _start) / _step).fill(0).map((v, i) => _start + (i * _step));
}