import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

const VIDEO_SRC = "/videos/comptoir-demo.mp4";
const LOGIN_PATH = "/";

export function WatchDemoPage() {
 const navigate = useNavigate();
 const [redirecting, setRedirecting] = useState(false);

 const goToLogin = () => {
  setRedirecting(true);
  navigate(LOGIN_PATH, { replace: true });
 };

 return (
  <main className="min-h-screen bg-background flex items-center justify-center px-[var(--space-lg)] py-[var(--space-2xl)]">
   <div className="w-full max-w-4xl">
    <div className="mb-[var(--space-xl)] text-center">
     <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-[0.2em] uppercase mb-[var(--space-sm)]">
      Comptoir
     </p>
     <h1 className="text-[length:var(--text-3xl)] font-bold tracking-[-0.04em] leading-tight">
      Découvrez Comptoir en vidéo
     </h1>
     <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)]">
      À la fin de la vidéo, vous serez redirigé vers l'application.
     </p>
    </div>

    <div className="border border-border bg-black rounded-[var(--radius-lg)] overflow-hidden shadow-sm flex justify-center">
     <video
      className="max-h-[72vh] w-auto max-w-full bg-black"
      controls
      playsInline
      preload="metadata"
      onEnded={goToLogin}
     >
      <source src={VIDEO_SRC} type="video/mp4" />
      Votre navigateur ne peut pas lire cette vidéo.
     </video>
    </div>

    <div className="mt-[var(--space-lg)] flex flex-col sm:flex-row items-center justify-center gap-[var(--space-md)]">
     <Button onClick={goToLogin} className="w-full sm:w-auto h-[var(--space-2xl)] px-[var(--space-xl)] font-bold">
      {redirecting ? "Redirection..." : "Accéder à l'application"}
     </Button>
     <p className="text-[length:var(--text-xs)] text-muted-foreground text-center">
      Si la vidéo ne se lance pas, utilisez ce bouton pour continuer.
     </p>
    </div>
   </div>
  </main>
 );
}
