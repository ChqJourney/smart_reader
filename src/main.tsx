import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { DictionaryStatusProvider } from "./hooks/useDictionaryStatus";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <DictionaryStatusProvider>
        <App />
      </DictionaryStatusProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
