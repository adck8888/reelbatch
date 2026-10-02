import { render } from 'preact';
import { App } from './App';
import { init } from './store';

render(<App />, document.getElementById('app')!);
void init();
