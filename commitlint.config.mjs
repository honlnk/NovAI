const allowedScopes = [
  'app',
  'build',
  'ci',
  'config',
  'deps',
  'docs',
  'git',
  'layout',
  'other',
  'project',
  'router',
  'store',
  'style',
  'test',
  'ui',
  'view',
];

// Keep the rule set simple and stable for this repository.
const userConfig = {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    'commitlint-plugin-function-rules',
    {
      rules: {
        'subject-match': (parsed) => {
          const subject = parsed.subject?.trim() || '';
          if (!subject) {
            return [false, 'subject is required'];
          }

          if (/[\u4e00-\u9fff]/.test(subject)) {
            return [true];
          }

          return [false, 'subject 必须包含中文，请使用中文提交说明'];
        },
      },
    },
  ],
  rules: {
    'body-leading-blank': [1, 'always'],
    'footer-leading-blank': [1, 'always'],
    'function-rules/scope-enum': [
      2,
      'always',
      (parsed) => {
        const scope = parsed.scope?.trim() || '';
        if (!scope) {
          return [false, 'scope is required'];
        }

        if (allowedScopes.includes(scope)) {
          return [true];
        }

        return [false, `scope must be one of ${allowedScopes.join(', ')}`];
      },
    ],
    'header-max-length': [2, 'always', 108],
    'scope-empty': [2, 'never'],
    'subject-case': [0],
    'subject-empty': [2, 'never'],
    'subject-match': [2, 'always'],
    'type-empty': [2, 'never'],
    'type-enum': [
      2,
      'always',
      [
        'build',
        'ci',
        'chore',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
  },
};

export default userConfig;
