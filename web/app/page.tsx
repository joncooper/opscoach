import { redirect } from "next/navigation";

// Beaconkeeper is the flagship demo, so the home route drops you straight into it.
// The full catalog lives at /catalog (linked from the nav and the launch screen).
export default function HomePage() {
  redirect("/play/beaconkeeper/beaconkeeper");
}
