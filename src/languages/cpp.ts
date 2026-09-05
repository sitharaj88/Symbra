import { makeCFamily } from './c_shared.js';

/** C++ (and CUDA / Objective-C++ sources, which are close enough for symbol extraction). */
export const cpp = makeCFamily({
  id: 'cpp',
  grammar: 'cpp',
  extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.cu', '.cuh', '.mm'],
  cpp: true,
});
