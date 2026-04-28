import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDBqPTloSp1MWBFcVMY6mdgyYKoqhTwFRA",
  authDomain: "mari-d7c71.firebaseapp.com",
  projectId: "mari-d7c71",
  storageBucket: "mari-d7c71.firebasestorage.app",
  messagingSenderId: "477197039887",
  appId: "1:477197039887:web:f00b662c87d6eb74d2667a",
  measurementId: "G-Q8LZDG6YNV"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
