import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/app.css'
import { App } from './App'
import { Presenter } from './components/Presenter'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.hash === '#presenter' ? <Presenter /> : <App />}
  </StrictMode>
)
