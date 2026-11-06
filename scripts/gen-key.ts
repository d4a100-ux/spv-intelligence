import { randomBytes } from "node:crypto";
// Gera a CREDENTIALS_KEY (32 bytes). Cole no .env.local / variáveis do servidor. Não compartilhe.
console.log(randomBytes(32).toString("base64"));
