# Auris — player dos áudios de estudo no Google Drive

O Auris é um player que roda no navegador (computador, Android e iPhone) e toca os MP3 guardados numa pasta do seu Google Drive. As subpastas viram as categorias; você monta playlists, escolhe a velocidade, retoma cada áudio de onde parou e pode guardar áudios no aparelho para ouvir sem internet. Playlists, progresso e opções se sincronizam entre os aparelhos por um arquivo oculto que o próprio app mantém no seu Drive.

Versão 1.0.0, de 18/10/2026.

## Arquivos

Todos ficam soltos na raiz do repositório, sem subpastas:

| Arquivo | Função |
|---|---|
| `index.html` | página do app |
| `estilos.css` | aparência |
| `app.js` | todo o funcionamento |
| `config.js` | onde você cola o ID de cliente OAuth |
| `sw.js` | permite instalar o app e abri-lo sem internet |
| `manifest.webmanifest` | nome e ícone do app instalado |
| `icone.svg`, `icone-192.png`, `icone-512.png` | ícones |
| `README.md` | este guia |

## Passo 1 — Publicar no GitHub Pages

1. No GitHub, crie um repositório (por exemplo, `auris`). Na conta gratuita, o GitHub Pages exige repositório público. Isso não expõe nada seu: o repositório só contém o programa; os áudios e o progresso ficam no seu Drive.
2. Na página do repositório, clique em *Add file › Upload files*, arraste os dez arquivos de uma vez e confirme com *Commit changes*.
3. Vá em *Settings › Pages*. Em *Source*, escolha *Deploy from a branch*; em *Branch*, escolha `main` e a pasta `/ (root)`; salve.
4. Em um ou dois minutos o endereço aparece no topo da mesma página, no formato `https://SEU-USUARIO.github.io/auris/`.

## Passo 2 — Autorizar o endereço no Google Cloud

Você já tem um projeto e uma credencial OAuth (a do Códex). Pode reaproveitá-los.

1. Abra o [Google Cloud Console](https://console.cloud.google.com/) e selecione o projeto.
2. Em *APIs e serviços › Biblioteca*, procure *Google Drive API* e confirme que está ativada (se não estiver, clique em *Ativar*).
3. Abra *Google Auth Platform* (antes chamado *Tela de consentimento OAuth*):
   - em *Público-alvo* (*Audience*), deixe o tipo *Externo* e o status *Em teste*, e acrescente o seu e-mail do Google em *Usuários de teste*;
   - em *Acesso a dados* (*Data access*), você pode adicionar os escopos `.../auth/drive.readonly` e `.../auth/drive.appdata`. Não é obrigatório, mas deixa a tela de autorização mais clara.
4. Em *Clientes* (*Clients*; em versões antigas, *Credenciais*), abra o seu cliente do tipo *Aplicativo da Web* e, em *Origens JavaScript autorizadas*, clique em *Adicionar URI* e informe somente o domínio, sem o nome do repositório e sem barra no fim:

   ```
   https://SEU-USUARIO.github.io
   ```

   O campo *URIs de redirecionamento autorizados* não precisa ser preenchido. Salve. A mudança pode levar alguns minutos para valer.
5. Copie o *ID do cliente* (termina em `.apps.googleusercontent.com`).

Uma única origem `https://SEU-USUARIO.github.io` serve para todos os seus projetos no GitHub Pages; se o Códex já está publicado lá, ela provavelmente já está cadastrada.

## Passo 3 — Gravar o ID no `config.js`

No GitHub, abra `config.js`, clique no lápis (*Edit*), cole o ID entre as aspas e salve (*Commit changes*):

```js
window.AURIS_CONFIG = {
  clientId: '000000000000-xxxxxxxxxxxx.apps.googleusercontent.com'
};
```

O ID de cliente não é segredo; ele aparece para qualquer um que abra a página, e o Google só aceita logins vindos das origens que você autorizou. Se preferir não editar o arquivo, o próprio app pede o ID na primeira abertura, mas aí será preciso informá-lo em cada aparelho.

## Passo 4 — Primeiro acesso

1. Abra o endereço do GitHub Pages e toque em *Entrar com Google*.
2. Como o app está em modo de teste, o Google mostra o aviso de que o app não foi verificado. Clique em *Avançado* e depois em *Acessar Auris (não seguro)*. Isso é normal em uso pessoal.
3. Marque as duas permissões: ver os arquivos do Drive e gerenciar os dados do próprio app (é a pasta oculta da sincronização).
4. Escolha a pasta onde estão os áudios, navegando pelo Drive ou colando o link da pasta.

## Como organizar os áudios no Drive

```
Áudios de estudo/            ← pasta escolhida no app
├── Direito Civil/
│   ├── Contratos/
│   │   ├── 01 Compra e venda.mp3
│   │   └── 02 Doação.mp3
│   ├── Aula 1 - Parte Geral.mp3
│   └── Aula 10 - Prescrição.mp3
└── Processo Civil/
    └── Recursos repetitivos.mp3
```

A ordenação é natural (Aula 2 vem antes de Aula 10). Atalhos do Drive para pastas ou áudios também funcionam. Formatos aceitos: MP3 e os demais que o navegador do aparelho tocar (M4A, OGG, WAV etc.). Depois de acrescentar arquivos no Drive, toque no botão de atualizar ao lado de *Pastas*; a biblioteca também é relida a cada abertura do app.

## Usando

- Velocidade: botão `1,0×` no player. Ajuste fino de 0,05 em 0,05 entre 0,5× e 3,5×, atalhos prontos e a opção de manter o tom da voz. A velocidade vale para todos os áudios e é sincronizada.
- Retomar: cada áudio guarda a posição e recomeça de onde parou, com um pequeno recuo para recuperar o contexto (ajustável). O tempo restante exibido já considera a velocidade.
- Ouvido: o áudio é marcado como ouvido ao chegar ao fim (97%). A opção *Ocultar ouvidos* mostra só o que falta numa pasta, e o botão *Continuar* começa pelo primeiro não terminado.
- Playlists: pelo menu ⋮ de um áudio ou de uma pasta, escolha *Adicionar à playlist*; para vários de uma vez, marque as caixas à esquerda e use a barra que aparece embaixo. Na playlist, arraste pela alça ⠿ para mudar a ordem (funciona no toque também).
- Fila: *Tocar em seguida* encaixa um áudio logo depois do atual; *Adicionar ao fim da fila* vai para o final. A fila pode ser reordenada e salva como playlist.
- Repetir (desligado, fila inteira ou um áudio), ordem aleatória e timer de sono (10 a 90 minutos ou ao fim do áudio, com o volume baixando nos últimos segundos).
- Offline: os áudios tocados ficam guardados no aparelho até o limite escolhido nos Ajustes (padrão 1 GB). Para garantir uma pasta ou playlist inteira sem internet, use *Disponibilizar offline* no menu ⋮; esses não saem pelo limite.
- Tela de bloqueio e fones: tocar, pausar, avançar, voltar e pular faixa funcionam pelos controles do sistema.
- Busca: no topo, por nome do áudio ou da pasta, sem diferenciar acentos.
- Teclado (computador): espaço tocar/pausar; ← e → voltar/avançar; Shift + ← e → áudio anterior/próximo; `[` e `]` velocidade; `0` volta a 1,0×; `S` aleatório; `R` repetição; `/` busca.

## Instalar no celular

- Android (Chrome): menu ⋮ › *Instalar app* ou *Adicionar à tela inicial*.
- iPhone (Safari): botão Compartilhar › *Adicionar à Tela de Início*.

Instalado, o Auris abre em tela cheia, como um aplicativo, e funciona sem internet para os áudios guardados no aparelho.

## Limitações conhecidas

- Cada áudio é baixado inteiro antes de começar a tocar, porque o Drive não permite que o player do navegador leia o arquivo diretamente com a sua autorização. Um MP3 de 30 a 50 MB leva alguns segundos numa boa conexão. Para compensar, o app baixa antecipadamente o áudio seguinte e guarda os recentes no aparelho.
- O acesso ao Google dura uma hora e é renovado sozinho no primeiro clique depois disso. Se a renovação não for possível, aparece o aviso *Reconectar*; os áudios guardados offline continuam tocando.
- No iPhone, a reprodução em segundo plano e com a tela bloqueada depende da versão do iOS, e o sistema pode apagar os áudios guardados se o app ficar semanas sem uso. Vale testar no seu aparelho.
- O app não foi testado com a sua conta real: o login e a leitura do Drive foram verificados com um Drive simulado. Os pontos a conferir no primeiro uso estão na seção abaixo.

## Se algo der errado

| O que aparece | O que fazer |
|---|---|
| Erro `origin_mismatch` ou `redirect_uri_mismatch` na janela do Google | A origem autorizada não confere. Deve ser exatamente `https://SEU-USUARIO.github.io`, sem barra no fim e sem o nome do repositório. Aguarde alguns minutos depois de salvar. |
| Erro `invalid_client` | O ID em `config.js` está incompleto ou é de outro projeto. |
| Erro `access_denied` ou "app bloqueado" | Seu e-mail não está entre os usuários de teste em *Público-alvo*. |
| "A Google Drive API não está ativada" | Ative a Google Drive API no projeto (Passo 2, item 2). |
| A janela de login não abre | O navegador bloqueou pop-ups; permita para o endereço do app. |
| A sincronização não funciona | Saia e entre de novo marcando as duas permissões. Confira a data da última sincronização em *Ajustes*. |
| Um áudio não toca | O formato pode não ser aceito pelo navegador do aparelho; converta para MP3. |
| Mudei os arquivos no GitHub e o app continua igual | Abra `sw.js`, aumente o número em `VERSAO` (por exemplo, `auris-app-1.0.1`) e envie de novo; o app avisa que há versão nova. |

## Privacidade

O Auris não tem servidor. Ele conversa só com o Google: lê os arquivos do seu Drive com a permissão de leitura e grava um único arquivo (`auris-estado.json`) na pasta oculta reservada ao app, que não aparece no seu Drive nem pode ser vista por outros apps. Para revogar o acesso, use *Sair* nos Ajustes ou remova o app em <https://myaccount.google.com/permissions>.
