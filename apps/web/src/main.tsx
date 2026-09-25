import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App";
import { RedirectIfAuthenticated, RequireAuth } from "./components/AuthGate";
import { AuthProvider } from "./context/AuthContext";
import { CartProvider } from "./context/CartContext";
import { CartPage } from "./pages/Cart";
import { CatalogPage } from "./pages/Catalog";
import { DashboardPage } from "./pages/Dashboard";
import { LoginPage } from "./pages/Login";
import { ProductDetailPage } from "./pages/ProductDetail";
import { RegisterPage } from "./pages/Register";
import { SellerOnboardingPage } from "./pages/SellerOnboarding";
import { SellerProductCreatePage } from "./pages/SellerProductCreate";
import { SellerProductDetailPage } from "./pages/SellerProductDetail";
import { StorefrontPage } from "./pages/Storefront";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element #root was not found in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <CartProvider>
          <Routes>
            <Route path="/" element={<App />} />
            <Route
              path="/login"
              element={
                <RedirectIfAuthenticated>
                  <LoginPage />
                </RedirectIfAuthenticated>
              }
            />
            <Route
              path="/register"
              element={
                <RedirectIfAuthenticated>
                  <RegisterPage />
                </RedirectIfAuthenticated>
              }
            />
            <Route
              path="/dashboard"
              element={
                <RequireAuth>
                  <DashboardPage />
                </RequireAuth>
              }
            />
            <Route
              path="/seller/onboarding"
              element={
                <RequireAuth>
                  <SellerOnboardingPage />
                </RequireAuth>
              }
            />
            <Route
              path="/seller/products/new"
              element={
                <RequireAuth>
                  <SellerProductCreatePage />
                </RequireAuth>
              }
            />
            <Route
              path="/seller/products/:productId"
              element={
                <RequireAuth>
                  <SellerProductDetailPage />
                </RequireAuth>
              }
            />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/catalog/products/:slug" element={<ProductDetailPage />} />
            <Route path="/store/:slug" element={<StorefrontPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </CartProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);