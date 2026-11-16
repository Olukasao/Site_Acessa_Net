import { configDefaults, defineConfig } from "vitest/config";

// Os pacotes irmaos (radius-bridge e router-agent) usam o runner nativo do Node (node --test), nao o vitest.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "router-agent/**", "radius-bridge/**"] }
});
