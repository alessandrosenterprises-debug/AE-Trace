import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '../services/backgroundTracking';

export default function RootLayout() {
  return <SafeAreaProvider><StatusBar style="light" /><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#08111f' } }} /></SafeAreaProvider>;
}
