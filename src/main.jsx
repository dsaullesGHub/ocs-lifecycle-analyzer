import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 40, fontFamily: 'system-ui', maxWidth: 600, margin: '40px auto' }}>
        <h2 style={{ color: '#E8523F' }}>Something went wrong</h2>
        <p>Try clearing your browser data for this site and reloading.</p>
        <pre style={{ background: '#f5f5f5', padding: 16, borderRadius: 8, fontSize: 12, overflow: 'auto' }}>{this.state.error.toString()}</pre>
        <button onClick={() => { indexedDB.deleteDatabase('ocs-lifecycle-db'); window.location.reload(); }}
          style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#2B4170', color: '#fff', cursor: 'pointer', marginTop: 12 }}>
          Clear Saved Data and Reload
        </button>
      </div>
    );
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
