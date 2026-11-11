import type { LangSpec } from '../spec.js';

export const c: LangSpec = {
  id: 'c',
  grammar: 'c',
  extensions: ['.c', '.h'],
  identifiers: [],
  visit: {},
};

export const cpp: LangSpec = {
  id: 'cpp',
  grammar: 'cpp',
  extensions: ['.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx', '.inl', '.ipp'],
  identifiers: [],
  visit: {},
};
