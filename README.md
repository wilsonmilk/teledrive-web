# TeleDrive Web

Cliente web que usa um canal privado do Telegram como nuvem pessoal.
Implementação independente inspirada no [TeleDrive](https://github.com/Mahmud0808/TeleDrive)
de Mahmud0808 — veja [Créditos](#créditos).
Roda inteiro no navegador — funciona no iPhone (adicionando à tela de início),
no Android e no desktop.

Não existe servidor intermediário: o navegador fala direto com o Telegram.

## Por que não tem servidor

O Telegram documenta e recomenda o transporte WebSocket justamente para
clientes de navegador:

> "when implementing browser clients, WebSocket transport is recommended instead of HTTP"
> — [core.telegram.org/mtproto/transports](https://core.telegram.org/mtproto/transports)

Então o fluxo é:

```
seu navegador  ──wss://──>  servidores do Telegram
```

A hospedagem (GitHub Pages) só entrega o HTML e o JavaScript. Depois que a
página carregou, **ela não participa de mais nada**. Não vê seu telefone, não
vê seu código de login, não vê seus arquivos.

Seu `api_id`, seu `api_hash` e a sessão ficam no `localStorage` deste
dispositivo e não saem dele.

## Antes de usar

Pegue suas credenciais em [my.telegram.org](https://my.telegram.org) →
**API development tools** → crie um aplicativo (qualquer nome serve).
Você recebe um `api_id` (número) e um `api_hash` (texto).

Use as **suas** credenciais. Não reaproveite as de outra pessoa.

## Publicar no GitHub Pages

Não precisa instalar nada na sua máquina — o GitHub compila sozinho.

1. Suba estes arquivos para um repositório **público**
2. No repositório: **Settings → Pages → Source → GitHub Actions**
3. Faça um push na branch `main`

A cada push o workflow em `.github/workflows/deploy.yml` compila e publica.
O endereço fica:

```
https://SEU-USUARIO.github.io/NOME-DO-REPO/
```

## Rodar na sua máquina (opcional)

```bash
npm install
npm run dev
```

## Usar no iPhone

Abra o endereço no **Safari**, toque em Compartilhar → **Adicionar à Tela de Início**.

Isso importa: um app na tela de início fica isento da regra do Safari que
apaga os dados de sites após 7 dias sem uso. Aberto como aba comum, você
teria que refazer o login periodicamente.

Atenção: a aba do Safari e o app da tela de início usam **espaços de
armazenamento separados**. Logar em um não loga no outro.

## O que esta versão faz

- **Cria o canal sozinho.** Na primeira entrada o app procura um canal privado
  marcado com `#teledrive-storage` e, se não achar, cria um chamado `TeleDrive`.
- **Pastas de verdade**, com trilha de navegação, renomear e remover em
  cascata — renomear uma pasta reescreve o caminho de todos os arquivos dela.
- **Seleção múltipla** com caixas, `Shift` para intervalo, `Ctrl` para avulsos,
  `Ctrl+A` para tudo e **arrastando o mouse no espaço vazio** para marcar
  vários de uma vez. Funciona com arquivos e com pastas, e as ações em lote
  entendem as duas coisas: mover uma pasta reescreve o caminho de tudo que
  está dentro dela.
- **Mover com árvore de pastas**, e arrastando o arquivo sobre a pasta ou
  sobre a trilha de navegação.
- **Enviar arquivos ou pasta inteira**, pelo botão, arrastando ou pelo menu do
  botão direito, recriando a estrutura de subpastas.
- **Fila de transferências** com progresso, cancelar os pendentes e repetir os
  que falharam.
- **Envio em pedaços**: cada parte é lida do disco só na hora de subir, então
  a memória usada não cresce com o tamanho do arquivo. Vale também para
  cifrar, que acontece bloco a bloco enquanto o envio corre.
- **Duplicados**: ao reenviar uma pasta, arquivos que já existem no destino
  param e perguntam — pular, substituir ou manter os dois — com a opção de
  aplicar a mesma escolha a todos os próximos. O diálogo compara os tamanhos,
  então dá para ver de relance se já foi copiado.
- **Histórico de envios** guardado no navegador, com filtro para o que passou
  de 2 GB ou falhou, e exportação em texto. A fila some ao ser fechada; o
  histórico não.
- **Lista e grade**, com miniatura real das imagens carregada sob demanda e
  ícone colorido por tipo de arquivo.
- **Abrir sem baixar**: imagens e PDFs abrem num visualizador, e **vídeo e
  áudio tocam por streaming** — um service worker traduz os pedidos de faixa
  do player em buscas pontuais no Telegram, então dá para pular no meio de um
  arquivo de 1 GB sem baixar o resto.
- **Busca no drive inteiro**, mostrando a pasta de cada resultado.
- **Favoritos** e **lixeira** com restaurar, apagar de vez e esvaziar.
- **Renomear no lugar**, clicando pelo menu ou com `F2`, com a extensão
  preservada fora da seleção.
- **Painel de detalhes** com tamanho, tipo, datas, estado da criptografia e o
  número da mensagem no canal.
- **Atalhos**: `/` busca, `Ctrl+A` seleciona, `F2` renomeia, `Delete` manda
  para a lixeira, `Enter` abre, `Esc` limpa. Nos diálogos, `Enter` confirma e
  `Esc` cancela.
- Ordenação e modo de visualização ficam guardados entre sessões.
- **Confirmar antes de remover** é opcional, ligado por padrão. Apagar de vez
  sempre pergunta, porque não tem volta.
- **Criptografia opcional**, desligada por padrão, com chave portável entre
  aparelhos.
- Tema claro e escuro, e layout que funciona no iPhone.

## Um drive, vários aparelhos

Este cliente foi feito para conviver com o
[TeleDrive](https://github.com/Mahmud0808/TeleDrive) original, não para
substituí-lo. O mesmo canal é lido pelos dois.

**A criptografia vem desligada**, como no app original (`encryptFiles = false`).
Desligada, tudo sobe em claro com legenda `td1:` e qualquer instalação do
TeleDrive — Windows, Mac, Linux, Android — abre o drive sem configuração
nenhuma. É o caminho recomendado para quem usa vários aparelhos.

Ligando a criptografia, é preciso antes criar ou importar uma chave. O arquivo
`teledrive.keybackup` é o mesmo formato que o TeleDrive exporta e lê, então a
chave viaja entre os aparelhos e todos continuam enxergando os mesmos arquivos.

### Os três formatos, e por que eles importam

| O quê | Formato |
|---|---|
| Metadados em claro | legenda `td1:` + JSON |
| Metadados cifrados | legenda `tde1:` + base64 de `nonce(12) + AES-GCM` |
| Conteúdo de arquivo | `TDE1` em blocos de 1 MB, nonce = salt + índice, AAD amarrando índice e último bloco |
| Backup de chave | `TDKB` + iterações + salt + dica + chave selada |

Conteúdo de arquivo e metadados usam esquemas **diferentes** — trocar um pelo
outro quebra a compatibilidade sem dar erro visível.

A compatibilidade é verificada com um teste que implementa o lado Java do
TeleDrive e troca arquivos com este cliente nos dois sentidos: backup de chave,
legenda cifrada e arquivo de vários blocos.

## Sobre o limite de 2 GB do Telegram

O teto é **por arquivo**, não por envio. Cada arquivo vira uma mensagem
independente no canal, enviada uma de cada vez — então uma pasta com centenas
de PDFs sobe sem problema. Só um arquivo isolado acima de 2 GB é recusado, e
nesse caso o app avisa e segue para o próximo em vez de abortar tudo.

## O que ainda não faz

- Streaming de arquivo **cifrado** — o formato TDE1 é em blocos, e alinhar as
  faixas HTTP aos blocos de criptografia ainda não está feito. Cifrado abre
  por download completo.
- Arquivos divididos em partes, acima do limite do Telegram
- Pasta vazia só existe neste navegador até receber o primeiro arquivo
- Miniatura de arquivo cifrado — o Telegram só vê bytes embaralhados
- Cancelar uma transferência já em andamento (só as que estão na fila)

Arquivos acima de 2 GB são recusados pelo Telegram (4 GB com Premium) e ficam
registrados no histórico para você reencontrá-los depois. Arquivos de 0 byte
também não sobem: o Telegram não aceita documento sem conteúdo.

## Pilha

[GramJS](https://github.com/gram-js/gramjs) (`telegram` no npm) para o MTProto,
compilado com [Vite](https://vitejs.dev/).

O repositório do GramJS está arquivado, mas o pacote recebeu publicação
recente e tem suporte a navegador declarado. Se virar problema, o
[`teleproto`](https://www.npmjs.com/package/teleproto) é um fork ativo com a
mesma API.

## Licença

MIT.
