import { createContext } from "react";

/** Ponto de extensão do login: componente opcional desenhado dentro do painel de marca (fundo). */
export const LoginBackdropContext = createContext(null);

/** Extras opcionais do app: { LoginFooter, ProfileExtras }. Sem provedor (o site), nada é renderizado. */
export const AppExtrasContext = createContext(null);
