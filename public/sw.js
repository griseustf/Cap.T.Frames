// Service worker mínimo, só pra melhorar a compatibilidade do prompt de
// "instalar app" em navegadores mais antigos. Não guarda nada em cache.
self.addEventListener("fetch", () => {
  // Intencionalmente vazio: deixa o navegador buscar tudo normalmente.
});
