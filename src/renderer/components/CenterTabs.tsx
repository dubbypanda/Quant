import { useApp } from '../store';
import { AnalysisLab } from './AnalysisLab';
import { MarketPulse } from './MarketPulse';
import { NewsFeed } from './NewsFeed';
import { SignalBoard } from './SignalBoard';
import { SettingsPanel } from './SettingsPanel';
import { PortfolioPage } from './portfolio/PortfolioPage';
import { DiscoverPage } from './discovery/DiscoverPage';
import { TodayPage } from './discovery/TodayPage';
import '../styles/analysis.css';
import '../styles/signals.css';

export function CenterTabs() {
  const { state, actions } = useApp();
  return (
    <div className="center-tabs">
      <div className="ct-bar" role="tablist" aria-label="Center workspace">
        <button
          type="button"
          role="tab"
          aria-selected={state.centerTab === 'today'}
          className={state.centerTab === 'today' ? 'ct-tab is-active' : 'ct-tab'}
          onClick={() => actions.setCenterTab('today')}
        >
          Today
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.centerTab === 'pulse'}
          className={state.centerTab === 'pulse' ? 'ct-tab is-active' : 'ct-tab'}
          onClick={() => actions.setCenterTab('pulse')}
        >
          Market Pulse
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.centerTab === 'news'}
          className={state.centerTab === 'news' ? 'ct-tab is-active' : 'ct-tab'}
          onClick={() => actions.setCenterTab('news')}
        >
          Market News
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.centerTab === 'analysis'}
          className={state.centerTab === 'analysis' ? 'ct-tab is-active' : 'ct-tab'}
          onClick={() => actions.setCenterTab('analysis')}
        >
          Analysis Lab
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.centerTab === 'signals'}
          className={state.centerTab === 'signals' ? 'ct-tab is-active' : 'ct-tab'}
          onClick={() => actions.setCenterTab('signals')}
        >
          Signal Board
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.centerTab === 'discover'}
          className={state.centerTab === 'discover' ? 'ct-tab is-active' : 'ct-tab'}
          onClick={() => actions.setCenterTab('discover')}
        >
          Discover
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.centerTab === 'portfolio'}
          className={state.centerTab === 'portfolio' ? 'ct-tab is-active' : 'ct-tab'}
          onClick={() => actions.setCenterTab('portfolio')}
        >
          Portfolio
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.centerTab === 'settings'}
          className={state.centerTab === 'settings' ? 'ct-tab is-active' : 'ct-tab'}
          onClick={() => actions.setCenterTab('settings')}
        >
          Settings
        </button>
      </div>
      <div className="ct-panel" role="tabpanel">
        <div className="ct-view" key={state.centerTab}>
          {state.centerTab === 'pulse' && <MarketPulse />}
          {state.centerTab === 'news' && <NewsFeed />}
          {state.centerTab === 'analysis' && <AnalysisLab />}
          {state.centerTab === 'signals' && <SignalBoard />}
          {state.centerTab === 'today' && (
            <TodayPage onOpenSymbol={(symbol) => actions.openChart(symbol)} />
          )}
          {state.centerTab === 'discover' && (
            <DiscoverPage onOpenSymbol={(symbol) => actions.openChart(symbol)} />
          )}
          {state.centerTab === 'portfolio' && (
            <PortfolioPage onOpenSymbol={(symbol) => actions.openChart(symbol)} />
          )}
          {state.centerTab === 'settings' && <SettingsPanel />}
        </div>
      </div>
    </div>
  );
}
