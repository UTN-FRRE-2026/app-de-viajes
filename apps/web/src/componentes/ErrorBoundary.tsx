import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { MensajeError } from './MensajeError';

/** Una falla al dibujar una pantalla no tira abajo toda la página: queda el layout y el mensaje. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Error al dibujar la pantalla', error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return <MensajeError error={this.state.error} onReintentar={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

/** `errorElement` del router: una ruta que no existe o una falla fuera de una pantalla. */
export function ErrorDeRuta() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <main className="contenido">
        <h1>No existe esa página</h1>
        <Link to="/">Volver al inicio</Link>
      </main>
    );
  }
  return (
    <main className="contenido">
      <MensajeError error={error} />
      <Link to="/">Volver al inicio</Link>
    </main>
  );
}
