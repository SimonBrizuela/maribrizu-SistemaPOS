import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCEFEyOC21UzIUOJWP-_8H-jdU_OYREaZg",
  authDomain: "store-9b7d3.firebaseapp.com",
  projectId: "store-9b7d3",
  storageBucket: "store-9b7d3.firebasestorage.app",
  messagingSenderId: "5213877612",
  appId: "1:5213877612:web:462a4d1ffeab0ca4602f49",
  measurementId: "G-VVJPZ77S8H"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
