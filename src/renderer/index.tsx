import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/app.css';
import './styles/chart-workspace.css';
import './styles/portfolio.css';

createRoot(document.getElementById('root')!).render(<App />);
