/**
 * Senhas comuns bloqueadas na criacao/troca de senha (politica: 8+ caracteres, letra e numero --
 * so as combinacoes que passariam nessa regra importam aqui).
 *
 * NAO e a lista oficial de nenhum vazamento: e um conjunto embutido (~1000+ entradas) gerado a partir de
 * (a) senhas muito usadas no Brasil e no mundo e (b) "palavra comum" x "sufixo comum" (123, 1234, 2024, @123...).
 * Cobre o grosso dos chutes de dicionario; nao substitui verificacao contra base de vazamentos (HIBP).
 */
const EXPLICIT = [
  "password1", "password12", "password123", "passw0rd", "p@ssw0rd", "p@ssword1", "senha123", "senha1234", "senha12345", "senha@123",
  "qwerty123", "qwerty1234", "qwerty12345", "qwertyuiop1", "qwe123456", "qwe12345", "asdf1234", "asdfg123", "asdfgh123", "zxcvbnm123",
  "abc12345", "abc123456", "abcd1234", "abcde12345", "a1b2c3d4", "a1b2c3d4e5", "1q2w3e4r", "1q2w3e4r5t", "1qaz2wsx", "1qaz@wsx", "q1w2e3r4", "q1w2e3r4t5",
  "iloveyou1", "iloveyou123", "eueteamo1", "teamo1234", "teamo12345", "meuamor1", "football1", "baseball1", "superman1", "batman123", "dragon123",
  "master123", "monkey123", "shadow123", "sunshine1", "princess1", "welcome1", "welcome123", "letmein123", "admin123", "admin1234", "administrador1",
  "login1234", "trustno1", "changeme1", "mudar123", "mudar@123", "trocar123", "teste123", "teste1234", "teste@123", "usuario123", "cliente123", "cliente@123",
  "acessanet1", "acessanet12", "acessanet123", "acessanet1234", "acessanet@123", "acessanet#123", "acessa123", "acessa1234", "acessanet2024", "acessanet2025", "acessanet2026",
  "internet123", "internet1234", "wifi12345", "wifi123456", "roteador123", "fibra12345", "fibra1234", "provedor123", "net12345", "net123456",
  "brasil123", "brasil1234", "brasil@123", "brasil2024", "brasil2025", "brasil2026", "flamengo1", "flamengo123", "corinthians1", "palmeiras1", "palmeiras123",
  "saopaulo1", "santos123", "gremio123", "cruzeiro1", "vasco1234", "botafogo1", "fluminense1", "internacional1", "atletico123",
  "amor12345", "amor123456", "deus12345", "deus123456", "jesus12345", "jesus123456", "deusefiel1", "familia123", "familia1234", "minhasenha1", "minhasenha123", "minhasenha@123",
  "12345678a", "123456789a", "1234567890a", "a12345678", "a123456789", "aa123456", "aaa12345", "aa12345678", "1234abcd", "12345abc", "123456abc", "123abc456", "123qweasd", "123qwe123",
  "mudar@2024", "mudar@2025", "mudar@2026", "senha@2024", "senha@2025", "senha@2026", "senha2024", "senha2025", "senha2026",
  "novasenha1", "novasenha123", "senhanova1", "senhaforte1", "senhasegura1", "senha1010", "senha2020", "senha2021", "senha2022", "senha2023",
  "lucas1234", "lucas12345", "maria1234", "maria12345", "joao12345", "pedro12345", "gabriel123", "gabriel1234", "rafael123", "daniel123", "felipe123", "bruno1234", "carlos123", "marcos123", "ana123456"
];

const BASE_WORDS = [
  "senha", "password", "passw0rd", "qwerty", "qwertyui", "asdfgh", "asdfghjk", "zxcvbn", "admin", "administrador", "root", "user", "usuario", "cliente", "teste", "test", "guest",
  "login", "welcome", "bemvindo", "mudar", "trocar", "secret", "segredo", "master", "mestre", "super", "abc", "abcd", "abcde", "iloveyou", "eutamo", "teamo", "amor", "amorzinho", "meuamor",
  "deus", "jesus", "familia", "fe", "paz", "brasil", "brazil", "saopaulo", "rio", "minas", "bahia", "recife", "fortaleza", "salvador", "curitiba", "goias",
  "flamengo", "corinthians", "palmeiras", "santos", "gremio", "cruzeiro", "vasco", "botafogo", "fluminense", "atletico", "internacional", "sport", "bahia",
  "acessanet", "acessa", "internet", "wifi", "fibra", "roteador", "provedor", "net", "online", "dragon", "monkey", "shadow", "sunshine", "princess", "football", "baseball",
  "soccer", "hockey", "batman", "superman", "pokemon", "naruto", "minecraft", "freefire", "fortnite", "cristiano", "neymar", "messi", "ronaldo", "mario", "zelda",
  "lucas", "maria", "joao", "pedro", "gabriel", "rafael", "daniel", "felipe", "bruno", "carlos", "marcos", "matheus", "guilherme", "gustavo", "leonardo", "rodrigo", "andre", "paulo", "fernando",
  "ana", "julia", "juliana", "fernanda", "camila", "amanda", "patricia", "aline", "mariana", "beatriz", "larissa", "leticia", "bruna", "jessica", "luciana", "sandra",
  "casa", "gato", "cachorro", "amigo", "amiga", "princesa", "gostosa", "lindo", "linda", "sol", "lua", "estrela", "felicidade", "saude", "dinheiro", "vitoria", "campeao", "guerreiro", "anjo"
];

const SUFFIXES = [
  "1", "12", "123", "1234", "12345", "123456", "1234567", "0", "00", "01", "10", "11", "22", "69", "77", "99", "100", "321", "007", "666", "777", "999", "1010", "2020", "2021", "2022", "2023", "2024", "2025", "2026",
  "@1", "@12", "@123", "@1234", "!1", "!12", "!123", "#123", "@2024", "@2025", "@2026", "*123", "_123"
];

function build(): Set<string> {
  const set = new Set<string>(EXPLICIT.map((value) => value.toLowerCase()));
  for (const word of BASE_WORDS) {
    for (const suffix of SUFFIXES) {
      set.add(`${word}${suffix}`);
    }
  }
  // Apenas digitos/sequencias com letra: repeticoes e "passos de teclado".
  for (const row of ["qwertyuiop", "asdfghjkl", "zxcvbnm", "abcdefghij", "1qaz2wsx3edc"]) {
    for (let length = 6; length <= row.length; length += 1) {
      for (const suffix of ["1", "12", "123", "1234"]) set.add(`${row.slice(0, length)}${suffix}`);
    }
  }
  return set;
}

const COMMON = build();

/** Troca leetspeak simples (@ -> a, 0 -> o, 1 -> i/l, 3 -> e, $ -> s, 5 -> s) so para a segunda checagem. */
function deleet(value: string) {
  return value.replace(/@/g, "a").replace(/\$/g, "s").replace(/0/g, "o").replace(/3/g, "e").replace(/5/g, "s");
}

export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return true;
  // Variacao so de maiusculas / simbolo final solto ("Senha123!").
  const stripped = lower.replace(/[^a-z0-9@]+$/g, "");
  if (stripped !== lower && COMMON.has(stripped)) return true;
  return DELEETED.has(deleet(lower));
}

const DELEETED = new Set<string>([...COMMON].map(deleet));

export const COMMON_PASSWORD_COUNT = COMMON.size;
