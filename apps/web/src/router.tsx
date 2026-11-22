import { createBrowserRouter } from 'react-router';
import { ErrorDeRuta } from './componentes/ErrorBoundary';
import { Layout } from './componentes/Layout';
import { Login } from './pantallas/Login';
import { MODULOS } from './roles';
import { IrAlInicio, RequiereRol, RequiereSesion } from './sesion/guardias';

/**
 * `/login` es pública. Todo lo demás pide sesión, y cada rol tiene su sección (`src/roles/`), montada
 * bajo su `base` y protegida por sus roles. Para sumar pantallas, ver `src/roles/index.tsx`.
 */
export const router = createBrowserRouter([
  { path: '/login', element: <Login />, errorElement: <ErrorDeRuta /> },
  {
    element: <RequiereSesion />,
    errorElement: <ErrorDeRuta />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <IrAlInicio /> },
          ...MODULOS.map((m) => ({ path: m.base, element: <RequiereRol roles={m.roles} />, children: m.rutas })),
        ],
      },
    ],
  },
]);
