module.exports = {
  locales: ["fr", "en", "es", "pt"],
  output: "src/i18n/locales/$LOCALE/$NAMESPACE.json",
  input: ["src/**/*.{ts,tsx}"],
  defaultNamespace: "common",
  namespaceSeparator: ":",
  keySeparator: ".",
  createOldCatalogs: false,
  keepRemoved: true,
  sort: true,
  defaultValue: function (locale, namespace, key, value) {
    return locale === "fr" ? value || key : "";
  },
  failOnWarnings: false,
  verbose: false,
  lexers: {
    ts: ["JavascriptLexer"],
    tsx: ["JsxLexer"],
    default: ["JavascriptLexer"],
  },
};
