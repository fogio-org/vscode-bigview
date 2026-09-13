import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test/.tmp/**', '.vscode-test/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Extension code must never read a whole file (SPEC §7.1).
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name=/^readFile(Sync)?$/]",
          message: 'Never read whole files (SPEC §7.1). Use FileHandlePool / ChunkReader.',
        },
      ],
    },
  },
);
