export type Player = 1 | 2;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface LobbyStats { online: number; playing: number; waiting: number }

export type LobbyView =
  | { kind: 'searching'; slow?: boolean }
  | { kind: 'friend'; error?: string }
  | { kind: 'room'; code: string; shareUrl: string }
  | { kind: 'joining'; code: string }
  | { kind: 'connecting' }
  | { kind: 'error'; title: string; text: string };

export interface GameOverView {
  title: string;
  subtitle: string;
  note?: string;
  primaryLabel: string;
  primaryDisabled?: boolean;
  showNewOpponent: boolean;
}

export class UI {
  // menu
  onPlay: () => void = () => {};
  onPlayOnline: () => void = () => {};
  onPlayFriend: () => void = () => {};
  onNameChange: (name: string) => void = () => {};
  // lobby
  onCreateRoom: () => void = () => {};
  onJoinRoom: (code: string) => void = () => {};
  onShare: () => void = () => {};
  onWhatsApp: () => void = () => {};
  onLobbyCancel: () => void = () => {};
  // game
  onRestart: () => void = () => {};
  onNewOpponent: () => void = () => {};
  onMenu: () => void = () => {};
  onLeave: () => void = () => {};
  onSoundToggle: (enabled: boolean) => void = () => {};

  private menuEl = $('menu');
  private tutorialEl = $('tutorial');
  private hudEl = $('hud');
  private gameOverEl = $('game-over');
  private lobbyEl = $('lobby');
  private p1ScoreEl = $('p1-score');
  private p2ScoreEl = $('p2-score');
  private p1LabelEl = $('p1-label');
  private p2LabelEl = $('p2-label');
  private p1SideEl = $('p1-side');
  private p2SideEl = $('p2-side');
  private turnEl = $('turn-indicator');
  private hintEl = $('hint-text');
  private blastEl = $('blast-flash');
  private goTitleEl = $('go-title');
  private goSubtitleEl = $('go-subtitle');
  private goNoteEl = $('go-note');
  private restartBtn = $<HTMLButtonElement>('btn-restart');
  private newOppBtn = $<HTMLButtonElement>('btn-new-opponent');
  private soundBtn = $<HTMLButtonElement>('sound-toggle');
  private leaveBtn = $<HTMLButtonElement>('btn-leave');
  private netBanner = $('net-banner');
  private nameInput = $<HTMLInputElement>('name-input');
  private onlineCountEl = $('online-count');
  private codeInput = $<HTMLInputElement>('code-input');
  private shareFeedback = $('share-feedback');

  private soundEnabled = true;
  private leaveArmedUntil = 0;
  private leaveNeedsConfirm = false;

  constructor() {
    $('btn-play').addEventListener('click', () => this.onPlay());
    $('btn-online').addEventListener('click', () => { this.commitName(); this.onPlayOnline(); });
    $('btn-friend').addEventListener('click', () => { this.commitName(); this.onPlayFriend(); });
    $('btn-how').addEventListener('click', () => this.show(this.tutorialEl));
    $('btn-close-tut').addEventListener('click', () => this.hide(this.tutorialEl));

    this.nameInput.addEventListener('change', () => this.commitName());
    this.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.nameInput.blur(); });

    $('btn-create-room').addEventListener('click', () => this.onCreateRoom());
    $('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = this.codeInput.value.trim().toUpperCase();
      if (code.length >= 4) this.onJoinRoom(code);
      else this.codeInput.focus();
    });
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    $('btn-share').addEventListener('click', () => this.onShare());
    $('btn-whatsapp').addEventListener('click', () => this.onWhatsApp());
    $('btn-lobby-cancel').addEventListener('click', () => this.onLobbyCancel());

    this.restartBtn.addEventListener('click', () => this.onRestart());
    this.newOppBtn.addEventListener('click', () => this.onNewOpponent());
    $('btn-go-menu').addEventListener('click', () => this.onMenu());

    this.leaveBtn.addEventListener('click', () => this.requestLeave());

    this.soundBtn.addEventListener('click', () => {
      this.soundEnabled = !this.soundEnabled;
      this.soundBtn.textContent = this.soundEnabled ? '🔊' : '🔇';
      this.onSoundToggle(this.soundEnabled);
    });

    // Keyboard/IME needs text selection inside inputs even though the game disables it globally.
    for (const el of [this.nameInput, this.codeInput]) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
  }

  // ---------- screens ----------

  showMenu() {
    this.show(this.menuEl);
    this.hide(this.hudEl);
    this.hide(this.gameOverEl);
    this.hide(this.lobbyEl);
    this.hideNetBanner();
  }

  showHUD(online: boolean) {
    this.hide(this.menuEl);
    this.hide(this.lobbyEl);
    this.hide(this.gameOverEl);
    this.show(this.hudEl);
    this.leaveNeedsConfirm = online;
    this.disarmLeave();
    this.hideNetBanner();
  }

  setNameValue(name: string, placeholder: string) {
    this.nameInput.value = name;
    this.nameInput.placeholder = placeholder;
  }

  private stats: LobbyStats | null = null;
  private searching = false;

  /** Live "who's around" for the menu pill and the matchmaking screen. */
  setLobbyStats(st: LobbyStats | null) {
    this.stats = st;
    this.renderStats();
  }

  /** Kept for older call sites. */
  setOnlineCount(n: number | null) {
    this.setLobbyStats(n === null ? null : { online: n, playing: this.stats?.playing ?? 0, waiting: this.stats?.waiting ?? 0 });
  }

  private renderStats() {
    const pill = $('online-pill');
    const pillText = $('online-pill-text');
    const live = $('lobby-live');
    const st = this.stats;
    if (!st) {
      pill.classList.add('hidden');
      live.textContent = '';
      return;
    }
    // Counts include this player once they're connected.
    const others = Math.max(0, st.online - 1);
    const waitingOthers = Math.max(0, st.waiting - (this.searching ? 1 : 0));
    pill.classList.remove('hidden');
    pill.classList.toggle('hot', waitingOthers > 0);
    pill.classList.toggle('empty', others === 0);
    if (waitingOthers > 0) {
      pillText.textContent = `${waitingOthers} player${waitingOthers > 1 ? 's' : ''} waiting for a match — tap Play Online`;
    } else if (others > 0) {
      const free = Math.max(0, others - st.playing);
      pillText.textContent = `${others} other player${others > 1 ? 's' : ''} online` +
        (st.playing > 0 ? ` · ${st.playing} in games${free > 0 ? `, ${free} free` : ''}` : '');
    } else {
      pillText.textContent = 'No one else online right now — Play a Friend to invite someone';
    }
    live.textContent = this.searching
      ? (others > 0
        ? `${others} other player${others > 1 ? 's' : ''} online${st.playing > 0 ? ` · ${st.playing} in games` : ''}`
        : 'You\'re the only one online right now.')
      : '';
  }

  showLobby(view: LobbyView) {
    this.hide(this.menuEl);
    this.hide(this.gameOverEl);
    this.show(this.lobbyEl);

    const title = $('lobby-title');
    const text = $('lobby-text');
    const spinner = $('lobby-spinner');
    const friend = $('lobby-friend');
    const room = $('lobby-room');
    const err = $('lobby-error');
    const cancel = $('btn-lobby-cancel');

    [friend, room, err].forEach((el) => this.hide(el));
    this.show(spinner);
    cancel.textContent = '⌂ HOME';
    this.searching = view.kind === 'searching';
    this.renderStats();
    text.textContent = '';

    switch (view.kind) {
      case 'connecting':
        title.textContent = 'CONNECTING';
        text.textContent = 'Reaching the DULU server…';
        break;
      case 'searching':
        title.textContent = 'FINDING AN OPPONENT';
        text.textContent = view.slow
          ? 'Nobody else is looking right now. Keep waiting, or invite a friend with a room link.'
          : 'Matching you with the next player who taps Play Online.';
        break;
      case 'friend':
        title.textContent = 'PLAY A FRIEND';
        this.hide(spinner);
        this.show(friend);
        text.textContent = 'Create a room and send the link, or type the code your friend sent you.';
        if (view.error) { err.textContent = view.error; this.show(err); }
        this.codeInput.value = '';
        break;
      case 'room':
        title.textContent = 'ROOM READY';
        this.hide(spinner);
        $('room-code').textContent = view.code;
        this.shareFeedback.textContent = '';
        this.show(room);
        text.textContent = 'Send this link to your friend. The game starts when they open it.';
        break;
      case 'joining':
        title.textContent = `JOINING ${view.code}`;
        text.textContent = 'Connecting you to your friend…';
        break;
      case 'error':
        title.textContent = view.title;
        this.hide(spinner);
        text.textContent = view.text;
        cancel.textContent = '⌂ HOME';
        break;
    }
  }

  setShareFeedback(text: string) {
    this.shareFeedback.textContent = text;
  }

  // ---------- HUD ----------

  setNames(p1: string, p2: string) {
    this.p1LabelEl.textContent = p1;
    this.p2LabelEl.textContent = p2;
  }

  setScore(p1: number, p2: number) {
    this.p1ScoreEl.textContent = String(p1);
    this.p2ScoreEl.textContent = String(p2);
  }

  setActivePlayer(p: Player, label?: string) {
    this.p1SideEl.classList.toggle('active', p === 1);
    this.p2SideEl.classList.toggle('active', p === 2);
    this.turnEl.textContent = label ?? `PLAYER ${p}'S TURN`;
  }

  setHint(text: string) {
    this.hintEl.textContent = text;
  }

  flashBlast(text = 'BLAST! +1', variant: 'normal' | 'topie' = 'normal') {
    this.blastEl.textContent = text;
    this.blastEl.classList.remove('show', 'topie');
    void this.blastEl.offsetWidth; // restart the animation
    this.blastEl.classList.toggle('topie', variant === 'topie');
    this.blastEl.classList.add('show');
    if (variant === 'topie') {
      const f = document.getElementById('screen-flash');
      if (f) { f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); }
    }
    window.setTimeout(() => this.blastEl.classList.remove('show'), variant === 'topie' ? 1300 : 700);
  }

  showNetBanner(text: string) {
    this.netBanner.textContent = text;
    this.show(this.netBanner);
  }

  hideNetBanner() {
    this.hide(this.netBanner);
  }

  // ---------- game over ----------

  /** Local (same device) game over. */
  showGameOver(winner: Player, p1: number, p2: number, reason?: string) {
    this.showGameOverView({
      title: reason ? reason : `PLAYER ${winner} WINS!`,
      subtitle: `${p1} — ${p2}`,
      primaryLabel: 'PLAY AGAIN',
      showNewOpponent: false,
    });
  }

  showGameOverView(v: GameOverView) {
    this.goTitleEl.textContent = v.title;
    this.goSubtitleEl.textContent = v.subtitle;
    this.goNoteEl.textContent = v.note ?? '';
    this.restartBtn.textContent = v.primaryLabel;
    this.restartBtn.disabled = !!v.primaryDisabled;
    this.newOppBtn.classList.toggle('hidden', !v.showNewOpponent);
    this.setRematchAvailable(!v.primaryDisabled);
    this.hideNetBanner();
    this.show(this.gameOverEl);
  }

  updateGameOver(note: string, primaryLabel?: string, primaryDisabled?: boolean) {
    this.goNoteEl.textContent = note;
    if (primaryLabel) this.restartBtn.textContent = primaryLabel;
    if (primaryDisabled !== undefined) this.restartBtn.disabled = primaryDisabled;
  }

  /** Opponent is gone: no rematch possible, so make "new opponent" the main action. */
  setRematchAvailable(available: boolean) {
    this.restartBtn.classList.toggle('hidden', !available);
    this.newOppBtn.classList.toggle('btn-primary', !available);
    this.newOppBtn.classList.toggle('btn-secondary', available);
  }

  // ---------- helpers ----------

  private commitName() {
    this.onNameChange(this.nameInput.value);
  }

  /**
   * Home button / phone back button during a game. Online, leaving forfeits,
   * so the first press only asks ("tap again"); the second within 3 s leaves.
   */
  requestLeave() {
    if (this.leaveNeedsConfirm && performance.now() > this.leaveArmedUntil) {
      this.leaveArmedUntil = performance.now() + 3000;
      this.leaveBtn.classList.add('armed');
      this.leaveBtn.textContent = 'LEAVE GAME? TAP AGAIN';
      window.setTimeout(() => { if (performance.now() >= this.leaveArmedUntil) this.disarmLeave(); }, 3050);
      return;
    }
    this.disarmLeave();
    this.onLeave();
  }

  private disarmLeave() {
    this.leaveArmedUntil = 0;
    this.leaveBtn.classList.remove('armed');
    this.leaveBtn.textContent = '⌂ HOME';
  }

  private show(el: HTMLElement) { el.classList.remove('hidden'); }
  private hide(el: HTMLElement) { el.classList.add('hidden'); }
}
