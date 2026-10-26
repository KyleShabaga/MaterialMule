import { Navigate, useLocation, useParams } from 'react-router';

/** `/inventory?…` → `/sample-storage?…`, keeping filters. */
export function InventoryRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/sample-storage${search}`} replace />;
}

export function StorageUnitRedirect() {
  const { suNumber = '' } = useParams();
  return <Navigate to={`/sample-storage/${encodeURIComponent(suNumber)}`} replace />;
}
