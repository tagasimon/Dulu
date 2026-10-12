export type Player = 1 | 2;

export class UI {
  onPlay: () => void = () => {};
  onRestart: () => void = () => {};
  onSoundToggle: (enabled: boolean) => void = () => {};

  private menuEl = document.getElementById('menu')!;
  private tutorialEl = document.getElementById('tutorial')!;
  private hudEl = document.getElementById('hud')!;
  private gameOverEl = document.getElementById('game-over')!;
  private p1ScoreEl = document.getElementById('p1-score')!;
  private p2ScoreEl = document.getElementById('p2-score')!;
  private p1SideEl = document.getElementById('p1-side')!;
  private p2SideEl = document.getElementById('p2-side')!;
  private turnEl = document.getElementById('turn-indicator')!;
  private hintEl = document.getElementById('hint-text')!;
  private blastEl = document.getElementById('blast-flash')!;
  private goTitleEl = document.getElementById('go-title')!;
  private goSubtitleEl = document.getElementById('go-subtitle')!;
  private soundBtn = document.getElementById('sound-toggle') as HTMLButtonElement;

  private soundEnabled = true;

  constructor() {
    document.getElementById('btn-play')!.addEventListener('click', () => {
      this.hide(this.menuEl);
      this.onPlay();
    });
    document.getElementById('btn-how')!.addEventListener('click', () => {
      this.show(this.tutorialEl);
    });
    document.getElementById('btn-close-tut')!.addEventListener('click', () => {
      this.hide(this.tutorialEl);
    });
    document.getElementById('btn-restart')!.addEventListener('click', () => {
      this.hide(this.gameOverEl);
      this.onRestart();
    });
    this.soundBtn.addEventListener('click', () => {
      this.soundEnabled = !this.soundEnabled;
      this.soundBtn.textContent = this.soundEnabled ? '🔊' : '🔇';
      this.onSoundToggle(this.soundEnabled);
    });
  }

  showMenu() {
    this.show(this.menuEl);
    this.hide(this.hudEl);
    this.hide(this.gameOverEl);
  }

  showHUD() {
    this.hide(this.menuEl);
    this.show(this.hudEl);
    this.hide(this.gameOverEl);
  }

  setScore(p1: number, p2: number) {
    this.p1ScoreEl.textContent = String(p1);
    this.p2ScoreEl.textContent = String(p2);
  }

  setActivePlayer(p: Player) {
    this.p1SideEl.classList.toggle('active', p === 1);
    this.p2SideEl.classList.toggle('active', p === 2);
    this.turnEl.textContent = `PLAYER ${p}'S TURN`;
  }

  setHint(text: string) {
    this.hintEl.textContent = text;
  }

  flashBlast(text = 'BLAST! +1') {
    this.blastEl.textContent = text;
    this.blastEl.classList.add('show');
    window.setTimeout(() => this.blastEl.classList.remove('show'), 700);
  }

  showGameOver(winner: Player, p1: number, p2: number, reason?: string) {
    this.goTitleEl.textContent = reason ? reason : `PLAYER ${winner} WINS!`;
    this.goSubtitleEl.textContent = `${p1} — ${p2}`;
    this.show(this.gameOverEl);
  }

  private show(el: HTMLElement) { el.classList.remove('hidden'); }
  private hide(el: HTMLElement) { el.classList.add('hidden'); }
}
