import { makeCFamily } from './c_shared.js';

/** C. `.h` headers are parsed with the C grammar (C++ headers use .hpp/.hh/.hxx). */
export const c = makeCFamily({ id: 'c', grammar: 'c', extensions: ['.c', '.h'], cpp: false });
