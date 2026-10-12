import './style.css';
import { Game } from './game/Game';
import { UI } from './ui/UI';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const ui = new UI();
const game = new Game(canvas, ui);

ui.onPlay = () => {
  ui.showHUD();
  game.startNewGame();
};

ui.onRestart = () => {
  ui.showHUD();
  game.startNewGame();
};

ui.onSoundToggle = (enabled) => {
  game.setSoundEnabled(enabled);
};

game.init().then(() => {
  ui.showMenu();
});
