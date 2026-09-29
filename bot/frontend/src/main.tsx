import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { Login } from './components/Login';
import './index.css';

function Root() {
  const [authenticated, setAuthenticated] = useState<boolean>(
    () => Boolean(localStorage.getItem('token'))
  );

  useEffect(() => {
    const onAuthExpired = () => setAuthenticated(false);
    window.addEventListener('trading-auth-expired', onAuthExpired);

    return () => {
      window.removeEventListener('trading-auth-expired', onAuthExpired);
    };
  }, []);

  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />;
  }

  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
