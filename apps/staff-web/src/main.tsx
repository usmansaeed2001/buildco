import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { ApiError } from "./api/client";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { router } from "./router";
import "./styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data here is edited by a handful of colleagues, so a short staleness window
      // keeps lists current without a request per focus change.
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // Retrying a 4xx just repeats the same rejection. A 401 has already triggered
        // sign-out, a 403/404 will not change, and a 422 is our own bad request.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      // Never retry a mutation automatically: a POST that timed out may well have
      // succeeded, and repeating it would duplicate the write.
      retry: false,
    },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root is missing from index.html.");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
