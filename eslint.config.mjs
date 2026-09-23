/*
 * One rule, on purpose: React's rules of hooks.
 *
 * Commit 4580275 put a `useState` below an early `return null` in Forge Web's
 * SessionComposer. A project with no tabs changed the hook count between
 * renders, React threw, and the phone went blank. `rules-of-hooks` catches that
 * shape statically, so `npm run lint:hooks` runs in the Checks workflow on every
 * push. Nothing else is switched on — this is a gate, not a style guide.
 *
 * The parser is Babel's, not typescript-eslint's: the repo is on TypeScript 7,
 * whose npm package ships no JavaScript compiler API, and typescript-eslint
 * needs one (its peer range stops below 6.1). The hooks rule reads syntax only,
 * so Babel's TypeScript preset parses everything it needs.
 */
import babelParser from '@babel/eslint-parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/*.{js,mjs,cjs}',
      'mobile/dist/**',
      'mobile/dist-tv/**',
      'mobile/android/**',
    ],
  },
  {
    files: ['web/src/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}', 'mobile/**/*.{ts,tsx}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          presets: ['@babel/preset-typescript'],
        },
      },
    },
    linterOptions: {
      // The code carries `exhaustive-deps` disables written for editors; that
      // rule is off here, so they would all read as unused.
      reportUnusedDisableDirectives: 'off',
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
]
