# Cap.T.Frames

Página web que espelha a tela do Galaxy Tab S6 Lite no Galaxy Note 10 Lite
pelo cabo USB-C, usando o protocolo ADB e o [scrcpy](https://github.com/Genymobile/scrcpy)
rodando dentro do navegador (via [Tango ADB](https://tangoadb.dev/)).

Sem app instalado no Tab: basta ativar "Depuração USB" nas Opções do
desenvolvedor. A imagem é decodificada e desenhada em tela cheia direto no
Chrome do Note.

## Configuração inicial (uma vez só)

Depois do primeiro `git push`, ative o GitHub Pages neste repositório:

1. Vá em **Settings > Pages**.
2. Em **Source**, escolha **GitHub Actions**.

O workflow em `.github/workflows/deploy.yml` publica o site automaticamente
a cada push na branch `main`.

## Uso

1. Conecte o Tab no Note pelo cabo USB-C.
2. No Tab: Configurações > Opções do desenvolvedor > ative "Depuração USB".
3. No Note, abra a URL do GitHub Pages no Chrome.
4. Toque em "Conectar no Tab" e escolha o aparelho na lista.
5. Na primeira vez, autorize a depuração USB no próprio Tab.

## Ajustar qualidade do vídeo

As constantes `VIDEO_MAX_SIZE`, `VIDEO_BIT_RATE` e `VIDEO_MAX_FPS` estão no
topo de `src/main.ts`.

## Rodando localmente no Codespace

```sh
npm install
npm run dev
```

O WebUSB exige HTTPS ou `localhost` — dentro do Codespace, use a porta
encaminhada (o Codespace já serve por HTTPS automaticamente).
