// Минимальный ESLint только для Rules of Hooks (WEB-05). Остальные правила
// намеренно не включены — код под общий eslint не приводился.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "node_modules/**", "src/shared/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    // Плагин typescript-eslint только регистрируется (без правил) — в коде есть
    // eslint-disable-комментарии с его правилами, иначе ESLint считает их ошибкой.
    plugins: { "react-hooks": reactHooks, "@typescript-eslint": tseslint.plugin },

    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // X-08: только slog (lib/log.ts); console.* в prod вырезается сборкой
      "no-console": "error",
    },
  },
];
