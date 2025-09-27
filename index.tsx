
import React, { useState, useEffect, useMemo, useCallback, StrictMode, Fragment, useRef } from 'react';
import ReactDOM from 'react-dom/client';

declare var XLSX: any;

// --- Interfaces ---
interface Part {
  id: string;
  name: string;
  quantity: number;
  itemsPerKg: number;
  reorderPoint: number;
  baseCount?: number;
  baseWeight?: number;
  reorderTriggeredDate: string | null;
  dailyUsage?: number;
  leadTime?: number;
  safetyStockDays?: number;
}

interface Transaction {
    id: string;
    partId: string;
    partName: string;
    operation: 'ورود' | 'خروج';
    quantityChange: number;
    weightChangeKg: number;
    timestamp: string;
    snapshotQuantity: number;
    snapshotWeightKg: number;
}

interface User {
    id: string;
    username: string;
    displayName: string | null;
    permissions: { [key: string]: boolean };
    lastSeen: number | null;
    password?: string; // only for login/update
}

interface RequestOptions extends RequestInit {
    body?: any;
    user?: User | null;
    panelMode?: string;
}

// --- API Client ---
const API_BASE_URL = '';

const api = {
    async request(endpoint: string, options: RequestOptions = {}) {
        const { body, user, panelMode, ...customConfig } = options;
        const headers: HeadersInit = { 'Content-Type': 'application/json' };
        
        if (panelMode === 'personal' && user?.username) {
            (headers as Record<string,string>)['X-User-DB'] = user.username;
        }

        const config: RequestInit = {
            method: body ? 'POST' : 'GET',
            ...customConfig,
            headers: {
                ...headers,
                ...customConfig.headers,
            },
        };
        if (body) {
            config.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, config);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'An unknown error occurred' }));
                return Promise.reject(new Error(errorData.error || `Request failed with status ${response.status}`));
            }
            return response.json();
        } catch (error) {
            console.error('API request error:', error);
            return Promise.reject(error);
        }
    },

    login(credentials: any): Promise<User> {
        return this.request('/api/login', { body: credentials });
    },
    getBootstrapData(user: User, panelMode: string) {
        return this.request('/api/bootstrap', { user, panelMode });
    },
    getRawMaterialsList(user: User, panelMode: string) {
        return this.request('/api/raw-materials-list', { user, panelMode });
    },
    addPart(partData: Partial<Part>, user: User, panelMode: string) {
        return this.request('/api/parts', { body: partData, user, panelMode });
    },
    updatePart(partId: string, partData: Part, user: User, panelMode: string) {
        return this.request(`/api/parts/${partId}`, { method: 'PUT', body: partData, user, panelMode });
    },
    deletePart(partId: string, user: User, panelMode: string) {
        return this.request(`/api/parts/${partId}`, { method: 'DELETE', user, panelMode });
    },
    addTransaction(data: any, user: User, panelMode: string) {
        return this.request('/api/transactions', { body: data, user, panelMode });
    },
    updateLastSeen(userId: string) {
        return this.request(`/api/users/lastseen/${userId}`, { method: 'PUT' });
    },
    updateUser(userId: string, userData: Partial<User>) {
        return this.request(`/api/users/${userId}`, { method: 'PUT', body: userData });
    },
    updateAllUsers(users: User[]) {
        return this.request(`/api/users`, { method: 'PUT', body: users });
    },
    addUser(userData: Partial<User>) {
        return this.request('/api/users', { body: userData });
    },
    deleteUser(userId: string) {
        return this.request(`/api/users/${userId}`, { method: 'DELETE' });
    },
    restore(data: any) {
        return this.request('/api/restore', { method: 'POST', body: data });
    },
    getLastUpdate(): Promise<{lastUpdate: number}> {
        return this.request('/api/last-update');
    },
};


// --- Enums & Constants ---
const Permission = {
    // Main Warehouse (Grouped)
    CAN_VIEW_MAIN_WAREHOUSE: 'canViewMainWarehouse',
    CAN_EDIT_MAIN_WAREHOUSE: 'canEditMainWarehouse',
    // Main Warehouse (Granular)
    CAN_ADD_ITEMS: 'canAddItems',
    CAN_PERFORM_TRANSACTIONS: 'canPerformTransactions',
    CAN_EDIT_ITEMS: 'canEditItems',
    CAN_DELETE_ITEMS: 'canDeleteItems',
    // Production
    CAN_VIEW_PRODUCTION: 'canViewProduction',
    CAN_EDIT_PRODUCTION: 'canEditProduction',
    // Outsourcing
    CAN_VIEW_OUTSOURCING: 'canViewOutsourcing',
    CAN_EDIT_OUTSOURCING: 'canEditOutsourcing',
    // WIP Report
    CAN_VIEW_WIP_REPORT: 'canViewWipReport',
    CAN_EDIT_WIP_REPORT: 'canEditWipReport',
    // System
    CAN_VIEW_USERS: 'canViewUsers',
    CAN_EDIT_USERS: 'canEditUsers',
};

const PERMISSION_LABELS: Record<string, string> = {
    [Permission.CAN_VIEW_MAIN_WAREHOUSE]: "خواندن انبار اصلی",
    [Permission.CAN_EDIT_MAIN_WAREHOUSE]: "ویرایش انبار اصلی",
    [Permission.CAN_ADD_ITEMS]: "افزودن کالا (انبار اصلی)",
    [Permission.CAN_PERFORM_TRANSACTIONS]: "ثبت تراکنش (انبار اصلی)",
    [Permission.CAN_EDIT_ITEMS]: "ویرایش کالا (انبار اصلی)",
    [Permission.CAN_DELETE_ITEMS]: "حذف کالا (انبار اصلی)",
    [Permission.CAN_VIEW_PRODUCTION]: "خواندن تولید",
    [Permission.CAN_EDIT_PRODUCTION]: "ویرایش تولید",
    [Permission.CAN_VIEW_OUTSOURCING]: "خواندن برون‌سپاری",
    [Permission.CAN_EDIT_OUTSOURCING]: "ویرایش برون‌سپاری",
    [Permission.CAN_VIEW_WIP_REPORT]: "خواندن گزارش کارگاه‌ها",
    [Permission.CAN_EDIT_WIP_REPORT]: "ویرایش گزارش کارگاه‌ها",
    [Permission.CAN_VIEW_USERS]: "خواندن مدیریت کاربران",
    [Permission.CAN_EDIT_USERS]: "ویرایش مدیریت کاربران",
};

const DEFAULT_ADMIN_PERMISSIONS = Object.values(Permission).reduce((acc, p) => ({ ...acc, [p]: true }), {});
const DEFAULT_VIEWER_PERMISSIONS = Object.values(Permission).reduce((acc, p) => ({ ...acc, [p]: false }), {});

const normalizeSearchString = (str: any): string => {
  // Gracefully handle non-string inputs, including numbers from Excel
  if (str === null || str === undefined) return '';
  let s = String(str).trim();

  // Persian/Arabic character normalization
  s = s.replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک').replace(/[آأإ]/g, 'ا');

  // Convert Persian/Arabic numerals to Latin numerals
  const numeralsMap: { [key: string]: string } = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
  s = s.replace(/[۰-۹٠-٩]/g, char => numeralsMap[char]);

  // Collapse multiple whitespace characters into a single space
  s = s.replace(/\s+/g, ' ');

  // Convert to lowercase for case-insensitive comparison
  return s.toLowerCase();
};

// --- Custom Hooks ---
function useLocalStorage<T>(key: string, initialValue: T) {
    const [storedValue, setStoredValue] = useState<T>(() => {
        try {
            const item = window.localStorage.getItem(key);
            return item ? JSON.parse(item) : initialValue;
        } catch (error) { console.error(error); return initialValue; }
    });

    useEffect(() => {
        try {
            window.localStorage.setItem(key, JSON.stringify(storedValue));
        } catch (error) { console.error(`Error saving key “${key}”:`, error); }
    }, [key, storedValue]);

    return [storedValue, setStoredValue] as const;
}

// --- Reusable Components ---
const Card = ({ children, className = '' }: {children: React.ReactNode, className?: string}) => (
    <div className={`card p-6 ${className}`}>{children}</div>
);

interface FormInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    label?: string;
}

const FormInput = React.forwardRef<HTMLInputElement, FormInputProps>(({ label, id, ...props }, ref) => {
    return (
        <div>
            {label && <label htmlFor={id} className="block text-sm font-medium mb-1">{label}</label>}
            <input id={id} {...props} ref={ref} className="block w-full px-3 py-2 rounded-lg border text-base form-input transition disabled:opacity-50 disabled:cursor-not-allowed" />
        </div>
    );
});
FormInput.displayName = 'FormInput';

const FormSelect = ({ label, id, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & {label?:string}) => (
    <div>
        {label && <label htmlFor={id} className="block text-sm font-medium mb-1">{label}</label>}
        <select id={id} {...props} className="block w-full px-3 py-2 rounded-lg border text-base form-input form-select transition disabled:opacity-50 disabled:cursor-not-allowed">
            {children}
        </select>
    </div>
);

const PrimaryButton = ({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} className={`px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-lg shadow-md hover:bg-blue-700 disabled:bg-gray-500 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-950 focus:ring-blue-500 ${className}`}>
        {children}
    </button>
);

const IconButton = ({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} className={`relative p-2 rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-900 focus:ring-blue-500 ${className}`}>
        {children}
    </button>
);

const Modal = ({ children, isOpen, onClose, size = 'md', position = 'center' }: { children: React.ReactNode, isOpen: boolean, onClose: () => void, size?: 'md' | 'lg' | 'xl', position?: 'center' | 'top'}) => {
    if (!isOpen) return null;
    const sizeClass = {
        'md': 'max-w-md',
        'lg': 'max-w-3xl',
        'xl': 'max-w-6xl'
    }[size];
    const positionClass = position === 'center' ? 'items-center' : 'items-start pt-24';

    return (
        <div 
            className={`fixed inset-0 z-50 flex ${positionClass} justify-center p-4 modal-backdrop fade-in`}
            onClick={onClose}
        >
            <div className={`w-full ${sizeClass}`} onClick={e => e.stopPropagation()}>
                <div className="card shadow-2xl">{children}</div>
            </div>
        </div>
    );
};

const Toast = ({ message, type, onClose }: { message: string, type: 'info' | 'success' | 'error', onClose: () => void }) => {
    useEffect(() => {
        const timer = setTimeout(onClose, 5000); // Auto-close after 5 seconds
        return () => clearTimeout(timer);
    }, [onClose]);

    const typeClasses = {
        info: 'bg-blue-600',
        success: 'bg-green-600',
        error: 'bg-red-500',
    };

    return (
        <div 
            className={`fixed top-24 right-8 z-[100] p-4 rounded-lg shadow-2xl text-white ${typeClasses[type] || 'bg-gray-800'} transition-transform transform-gpu animate-slide-in`}
            role="alert"
            aria-live="assertive"
        >
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="font-semibold">{message}</span>
                </div>
                <button onClick={onClose} className="-mr-1 p-1 rounded-full hover:bg-white/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
            </div>
        </div>
    );
};

// --- Login Page ---
const LoginPage = ({ onLogin, setToast }: {onLogin: (user: User) => void, setToast: (toast: any) => void}) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [branding, setBranding] = useState<any>(null);

    useEffect(() => {
        fetch('./branding.json')
            .then(response => {
                if (!response.ok) throw new Error('Branding file not found');
                return response.json();
            })
            .then(data => setBranding(data))
            .catch(err => console.warn(err.message));
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);
        try {
            const user = await api.login({ username, password });
            onLogin(user);
        } catch (err: any) {
            setError(err.message || 'نام کاربری یا رمز عبور نامعتبر است.');
            setToast({ message: err.message, type: 'error' });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-950">
            <div className="w-full max-w-md space-y-6 fade-in p-8 rounded-xl bg-gray-900 border border-gray-700">
                {branding && branding.enabled && (
                    <div className="text-center mb-4">
                        {branding.logoUrl && <img src={branding.logoUrl} alt="Logo" className="w-32 h-32 object-cover mx-auto mb-4 rounded-full shadow-lg" />}
                        {branding.instagram && (
                            <a href={branding.instagram.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors">
                                <span>{branding.instagram.username}</span>
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.689-.073-4.948-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.162 6.162 6.162 6.162-2.759 6.162-6.162-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4s1.791-4 4-4 4 1.79 4 4-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44 1.441-.645 1.441-1.44c0-.795-.645-1.44-1.441-1.44z"/></svg>
                            </a>
                        )}
                    </div>
                )}
                <h2 className="text-3xl font-bold text-center text-white">سیستم مدیریت انبار</h2>
                <form onSubmit={handleSubmit} className="space-y-6">
                    <FormInput label="نام کاربری" id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus disabled={isLoading} />
                    <FormInput label="رمز عبور" id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={isLoading} />
                    {error && <p className="text-sm text-red-400 text-center">{error}</p>}
                    <PrimaryButton type="submit" className="w-full" disabled={isLoading}>
                      {isLoading ? 'در حال ورود...' : 'ورود'}
                    </PrimaryButton>
                </form>
            </div>
        </div>
    );
};

// --- Inventory Page Components ---
const TransactionForm = ({ parts, onTransaction, permissions, searchTerm, setSearchTerm, workshops, wages }: {parts: Part[], onTransaction: (partId: string, transactionQuantity: number, transactionRecord: Transaction, costDestinations: any[]) => void, permissions: Record<string, boolean>, searchTerm: string, setSearchTerm: (term: string) => void, workshops: any[], wages: any}) => {
    const [type, setType] = useState('exit');
    const [partId, setPartId] = useState('');
    const [quantity, setQuantity] = useState('');
    const [weight, setWeight] = useState('');
    const [error, setError] = useState('');
    const [showResults, setShowResults] = useState(false);
    const [costDestinations, setCostDestinations] = useState<{[key: string]: string}>({});

    const availableParts = useMemo(() => {
      if (!searchTerm) return [];
      const normalizedSearch = normalizeSearchString(searchTerm);
      return parts.filter(p => normalizeSearchString(p.name).includes(normalizedSearch));
    }, [parts, searchTerm]);

    const selectedPart = useMemo(() => parts.find(p => p.id === partId), [parts, partId]);

    useEffect(() => {
        setCostDestinations({});
    }, [partId]);

    const handlePartSelect = (part: Part) => {
        setPartId(part.id);
        setSearchTerm(part.name); // Keep search term to filter main list
        setShowResults(false);
        setQuantity('');
        setWeight('');
        setError('');
    };

    const handleQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setQuantity(val);
        if (selectedPart && val && !isNaN(parseFloat(val)) && selectedPart.itemsPerKg > 0) {
            const newWeight = parseFloat(val) / selectedPart.itemsPerKg;
            setWeight(newWeight > 0 ? newWeight.toFixed(3) : '');
        } else { setWeight(''); }
    };

    const handleWeightChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setWeight(val);
        if (selectedPart && val && !isNaN(parseFloat(val)) && selectedPart.itemsPerKg > 0) {
            const newQuantity = parseFloat(val) * selectedPart.itemsPerKg;
            setQuantity(newQuantity > 0 ? Math.round(newQuantity).toString() : '');
        } else { setQuantity(''); }
    };

    const handleCostDestinationChange = (workshopId: string, basis: string | null) => {
        setCostDestinations(prev => {
            const newDestinations = { ...prev };
            if (basis === null) { // Checkbox was unchecked
                delete newDestinations[workshopId];
            } else {
                newDestinations[workshopId] = basis;
            }
            return newDestinations;
        });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        const numQuantity = parseFloat(quantity);
        if (!selectedPart || isNaN(numQuantity) || numQuantity <= 0) {
            setError('لطفاً کالا و مقدار معتبر را وارد کنید.');
            return;
        }

        if (type === 'exit' && numQuantity > selectedPart.quantity) {
            setError('مقدار خروجی نمی‌تواند بیشتر از موجودی باشد.');
            return;
        }

        const transactionQuantity = type === 'entry' ? numQuantity : -numQuantity;
        const newQuantityAfter = Math.max(0, selectedPart.quantity + transactionQuantity);
        const weightChange = parseFloat(weight) || (selectedPart.itemsPerKg > 0 ? numQuantity / selectedPart.itemsPerKg : 0);
        const newTotalWeightAfter = selectedPart.itemsPerKg > 0 ? newQuantityAfter / selectedPart.itemsPerKg : 0;
        
        const transactionRecord: Transaction = { id: crypto.randomUUID(), partId: selectedPart.id, partName: selectedPart.name, operation: type === 'entry' ? 'ورود' : 'خروج', quantityChange: numQuantity, weightChangeKg: weightChange, timestamp: new Date().toISOString(), snapshotQuantity: newQuantityAfter, snapshotWeightKg: newTotalWeightAfter };
        
        const costDests = type === 'entry' ? Object.entries(costDestinations).map(([wsId, basis]) => ({ workshopId: wsId, basis })) : [];

        await onTransaction(selectedPart.id, transactionQuantity, transactionRecord, costDests);
        
        setQuantity(''); setWeight(''); setPartId(''); setError(''); setSearchTerm(''); setCostDestinations({});
    };

    const canTransact = permissions[Permission.CAN_PERFORM_TRANSACTIONS];
    const partWages = selectedPart ? wages[selectedPart.id] : null;
    const showCostSection = type === 'entry' && partWages && Object.keys(partWages).length > 0;
    const workshopsWithWage = showCostSection ? workshops.filter(ws => partWages[ws.id] !== undefined) : [];

    return (
        <Card className="flex-shrink-0">
            <h3 className="text-xl font-bold mb-4">ثبت ورود / خروج کالا</h3>
            <div className="flex border border-gray-300 dark:border-gray-600 rounded-lg p-1 mb-4 bg-gray-100 dark:bg-gray-900">
                <button onClick={() => setType('entry')} disabled={!canTransact} className={`w-1/2 p-2 rounded-md text-sm font-semibold transition ${type === 'entry' ? 'bg-green-600 text-white' : 'text-gray-700 dark:text-gray-300'} disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:text-gray-500`}>ورود</button>
                <button onClick={() => setType('exit')} disabled={!canTransact} className={`w-1/2 p-2 rounded-md text-sm font-semibold transition ${type === 'exit' ? 'bg-red-600 text-white' : 'text-gray-700 dark:text-gray-300'} disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:text-gray-500`}>خروج</button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="relative">
                    <FormInput 
                        label="جستجو و انتخاب کالا" 
                        id="trans-part-search" 
                        type="text"
                        value={searchTerm}
                        onChange={e => { setSearchTerm(e.target.value); setPartId(''); }}
                        onFocus={() => setShowResults(true)}
                        onBlur={() => setTimeout(() => setShowResults(false), 150)} // Delay to allow click
                        placeholder="نام کالا را تایپ کنید..."
                        autoComplete="off"
                    />
                    {showResults && searchTerm && (
                        <div className="absolute z-30 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg max-h-48 overflow-y-auto">
                            {availableParts.length > 0 ? (
                                <ul className="py-1">
                                    {availableParts.map(p => (
                                        <li key={p.id} className="px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer" onMouseDown={() => handlePartSelect(p)}>
                                            {p.name}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="px-3 py-2 text-sm text-text-muted-light dark:text-text-muted-dark">موردی یافت نشد.</p>
                            )}
                        </div>
                    )}
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <FormInput label="مقدار (تعداد)" id="trans-quantity" type="number" min="0" value={quantity} onChange={handleQuantityChange} placeholder="0" disabled={!partId} required/>
                  <FormInput label="مقدار (کیلوگرم)" id="trans-weight" type="number" min="0" step="any" value={weight} onChange={handleWeightChange} placeholder="0.0" disabled={!partId} required/>
                </div>

                {showCostSection && workshopsWithWage.length > 0 && (
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg border border-blue-200 dark:border-blue-800 space-y-3">
                        <h4 className="font-semibold text-sm text-blue-800 dark:text-blue-200">ثبت هزینه دستمزد خودکار</h4>
                        {workshopsWithWage.map(ws => (
                            <div key={ws.id} className="flex items-center gap-2 p-2 rounded-md bg-white dark:bg-gray-800/50">
                                <input 
                                    type="checkbox" 
                                    id={`cost-ws-${ws.id}`}
                                    checked={!!costDestinations[ws.id]}
                                    onChange={(e) => handleCostDestinationChange(ws.id, e.target.checked ? 'quantity' : null)}
                                    className="h-4 w-4 rounded"
                                />
                                <label htmlFor={`cost-ws-${ws.id}`} className="flex-grow text-sm font-medium">{ws.name}</label>
                                <div className="flex items-center gap-2 text-xs">
                                    <label className="flex items-center gap-1"><input type="radio" name={`cost-basis-${ws.id}`} value="quantity" checked={costDestinations[ws.id] === 'quantity'} onChange={() => handleCostDestinationChange(ws.id, 'quantity')} disabled={!costDestinations[ws.id]} /> تعداد</label>
                                    <label className="flex items-center gap-1"><input type="radio" name={`cost-basis-${ws.id}`} value="weight" checked={costDestinations[ws.id] === 'weight'} onChange={() => handleCostDestinationChange(ws.id, 'weight')} disabled={!costDestinations[ws.id]} /> وزن</label>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                
                {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
                {!canTransact && <p className="text-sm text-yellow-500 dark:text-yellow-400">شما دسترسی لازم برای ثبت تراکنش را ندارید.</p>}
                
                <PrimaryButton type="submit" disabled={!canTransact || !partId || !quantity} className={`w-full ${type === 'entry' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}>
                    ثبت عملیات
                </PrimaryButton>
            </form>
        </Card>
    );
};

const AddPartForm = ({ onAddPart, permissions }: {onAddPart: (part: Partial<Part>) => void, permissions: Record<string, boolean>}) => {
    const [name, setName] = useState('');
    const [baseCount, setBaseCount] = useState('');
    const [baseWeight, setBaseWeight] = useState('');
    const [initialQuantity, setInitialQuantity] = useState('');
    const [initialWeight, setInitialWeight] = useState('');
    const [reorderPoint, setReorderPoint] = useState('');
    const [dailyUsage, setDailyUsage] = useState('');
    const [leadTime, setLeadTime] = useState('');
    const [safetyStockDays, setSafetyStockDays] = useState('');
    const [error, setError] = useState('');
    const canAdd = permissions[Permission.CAN_ADD_ITEMS];

    const itemsPerKg = useMemo(() => {
        const numBaseCount = parseFloat(baseCount);
        const numBaseWeight = parseFloat(baseWeight);
        if (numBaseCount > 0 && numBaseWeight > 0) {
            return numBaseCount / numBaseWeight;
        }
        return null;
    }, [baseCount, baseWeight]);

    const optimizedReorderPoint = useMemo(() => {
        const numUsage = parseFloat(dailyUsage);
        const numLeadTime = parseFloat(leadTime);
        const numSafetyDays = parseFloat(safetyStockDays) || 0;
        if (numUsage > 0 && numLeadTime > 0) {
            return Math.ceil((numUsage * numLeadTime) + (numUsage * numSafetyDays));
        }
        return null;
    }, [dailyUsage, leadTime, safetyStockDays]);

    const handleInitialQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setInitialQuantity(val);
        if (itemsPerKg && val && !isNaN(parseFloat(val))) {
            const newWeight = parseFloat(val) / itemsPerKg;
            setInitialWeight(newWeight > 0 ? newWeight.toFixed(3) : '');
        } else {
            setInitialWeight('');
        }
    };

    const handleInitialWeightChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setInitialWeight(val);
        if (itemsPerKg && val && !isNaN(parseFloat(val))) {
            const newQuantity = parseFloat(val) * itemsPerKg;
            setInitialQuantity(newQuantity > 0 ? Math.round(newQuantity).toString() : '');
        } else {
            setInitialQuantity('');
        }
    };
    
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (!name.trim()) { setError('نام کالا نمی‌تواند خالی باشد.'); return; }
        if (!itemsPerKg) { setError('مقادیر تعریف واحد تبدیل باید اعداد مثبت باشند.'); return; }
        const numInitialQuantity = parseFloat(initialQuantity) || 0;
        
        await onAddPart({
            name: name.trim(),
            quantity: numInitialQuantity,
            itemsPerKg: itemsPerKg,
            reorderPoint: parseFloat(reorderPoint) || 0,
            baseCount: parseFloat(baseCount),
            baseWeight: parseFloat(baseWeight),
            dailyUsage: parseFloat(dailyUsage) || 0,
            leadTime: parseFloat(leadTime) || 0,
            safetyStockDays: parseFloat(safetyStockDays) || 0,
        });

        setName(''); setBaseCount(''); setBaseWeight(''); setInitialQuantity(''); setInitialWeight(''); setReorderPoint('');
        setDailyUsage(''); setLeadTime(''); setSafetyStockDays('');
    };
    
    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            <FormInput label="نام کالا" id="add-name" type="text" value={name} onChange={e => setName(e.target.value)} disabled={!canAdd} required />
            <div className="p-3 bg-gray-100 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                <label className="block text-sm font-medium mb-2">تعریف واحد تبدیل (وزن مبنا)</label>
                <div className="flex items-center gap-2">
                    <input id="add-base-count" type="number" min="1" step="1" value={baseCount} onChange={e => setBaseCount(e.target.value)} disabled={!canAdd} required placeholder="تعداد" className="w-full px-3 py-2 rounded-lg border text-base form-input transition disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-gray-500 dark:text-gray-400">عدد</span>
                    <span className="text-xl font-bold text-gray-400 dark:text-gray-500">=</span>
                    <input id="add-base-weight" type="number" min="0.001" step="any" value={baseWeight} onChange={e => setBaseWeight(e.target.value)} disabled={!canAdd} required placeholder="وزن" className="w-full px-3 py-2 rounded-lg border text-base form-input transition disabled:opacity-50 disabled:cursor-not-allowed" />
                    <span className="text-gray-500 dark:text-gray-400">ک‌گ</span>
                </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormInput label="موجودی اولیه (تعداد)" id="add-init-count" type="number" min="0" value={initialQuantity} onChange={handleInitialQuantityChange} disabled={!canAdd || !itemsPerKg} placeholder="0"/>
              <FormInput label="موجودی اولیه (وزن)" id="add-init-weight" type="number" min="0" step="any" value={initialWeight} onChange={handleInitialWeightChange} disabled={!canAdd || !itemsPerKg} placeholder="کیلوگرم" />
            </div>
             <div className="p-3 bg-gray-100 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 space-y-3">
                <label className="block text-sm font-medium">بهینه‌سازی نقطه سفارش (اختیاری)</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <FormInput label="مصرف روزانه" id="add-daily-usage" type="number" min="0" value={dailyUsage} onChange={e=>setDailyUsage(e.target.value)} disabled={!canAdd} placeholder="تعداد"/>
                    <FormInput label="زمان تحویل" id="add-lead-time" type="number" min="0" value={leadTime} onChange={e=>setLeadTime(e.target.value)} disabled={!canAdd} placeholder="روز"/>
                    <FormInput label="موجودی اطمینان" id="add-safety-stock" type="number" min="0" value={safetyStockDays} onChange={e=>setSafetyStockDays(e.target.value)} disabled={!canAdd} placeholder="روز"/>
                </div>
                {optimizedReorderPoint !== null && (
                    <div className="flex items-center justify-between p-2 bg-blue-100 dark:bg-blue-900/50 rounded-md">
                        <span className="text-sm font-medium text-blue-800 dark:text-blue-200">نقطه سفارش محاسبه شده: <span className="font-bold">{optimizedReorderPoint.toLocaleString()}</span></span>
                        <button type="button" onClick={() => setReorderPoint(optimizedReorderPoint.toString())} className="text-xs py-1 px-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition">اعمال</button>
                    </div>
                )}
            </div>
            <FormInput label="نقطه سفارش (تعداد)" id="add-reorderPoint" type="number" value={reorderPoint} onChange={e => setReorderPoint(e.target.value)} disabled={!canAdd} placeholder="مثلاً: ۵۰۰"/>
            {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
            {!canAdd && <p className="text-sm text-yellow-500 dark:text-yellow-400">شما دسترسی لازم برای افزودن کالا را ندارید.</p>}
            <PrimaryButton type="submit" disabled={!canAdd} className="w-full">افزودن کالا</PrimaryButton>
        </form>
    );
};

const EditItemModal = ({ item, isOpen, onClose, onSave, permissions }: {item: Part, isOpen: boolean, onClose: () => void, onSave: (part: Part) => void, permissions: Record<string, boolean>}) => {
    const [name, setName] = useState('');
    const [quantity, setQuantity] = useState('');
    const [itemsPerKg, setItemsPerKg] = useState('');
    const [reorderPoint, setReorderPoint] = useState('');
    const [baseCount, setBaseCount] = useState('');
    const [baseWeight, setBaseWeight] = useState('');
    const [dailyUsage, setDailyUsage] = useState('');
    const [leadTime, setLeadTime] = useState('');
    const [safetyStockDays, setSafetyStockDays] = useState('');
    
    useEffect(() => {
        if (item) {
            setName(item.name);
            setQuantity(item.quantity.toString());
            setItemsPerKg(item.itemsPerKg.toString());
            setReorderPoint(item.reorderPoint.toString());
            setBaseCount(item.baseCount?.toString() || '');
            setBaseWeight(item.baseWeight?.toString() || '');
            setDailyUsage(item.dailyUsage?.toString() || '');
            setLeadTime(item.leadTime?.toString() || '');
            setSafetyStockDays(item.safetyStockDays?.toString() || '');
        }
    }, [item]);

    const optimizedReorderPoint = useMemo(() => {
        const numUsage = parseFloat(dailyUsage);
        const numLeadTime = parseFloat(leadTime);
        const numSafetyDays = parseFloat(safetyStockDays) || 0;
        if (numUsage > 0 && numLeadTime > 0) {
            return Math.ceil((numUsage * numLeadTime) + (numUsage * numSafetyDays));
        }
        return null;
    }, [dailyUsage, leadTime, safetyStockDays]);

    useEffect(() => {
        const numBaseCount = parseFloat(baseCount);
        const numBaseWeight = parseFloat(baseWeight);
        if (numBaseCount > 0 && numBaseWeight > 0) {
            setItemsPerKg((numBaseCount / numBaseWeight).toString());
        }
    }, [baseCount, baseWeight]);
    
    const handleSave = () => {
        const numItemsPerKg = parseFloat(itemsPerKg);
        const numReorderPoint = parseFloat(reorderPoint);
        const numQuantity = parseFloat(quantity);
        if (name.trim() && !isNaN(numQuantity) && numQuantity >= 0 && !isNaN(numItemsPerKg) && numItemsPerKg > 0 && !isNaN(numReorderPoint)) {
            onSave({ 
                ...item, name, quantity: numQuantity, itemsPerKg: numItemsPerKg, reorderPoint: numReorderPoint, 
                baseCount: parseFloat(baseCount), baseWeight: parseFloat(baseWeight),
                dailyUsage: parseFloat(dailyUsage) || 0,
                leadTime: parseFloat(leadTime) || 0,
                safetyStockDays: parseFloat(safetyStockDays) || 0,
            });
            onClose();
        } else {
            alert('لطفاً مقادیر معتبر وارد کنید.');
        }
    };
    
    const canEdit = permissions[Permission.CAN_EDIT_ITEMS];

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" position="top">
            <div className="flex justify-between items-center p-5 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-xl font-bold">ویرایش کالا</h3>
                <IconButton onClick={onClose} className="-mt-2 -mr-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                </IconButton>
            </div>
            <div className="p-6 space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-5">
                    {/* Column 1: General Info */}
                    <div className="space-y-5">
                      <FormInput label="نام کالا" id="edit-name" value={name} onChange={e => setName(e.target.value)} disabled={!canEdit} />
                      <FormInput label="تعداد موجودی" id="edit-quantity" type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} disabled={!canEdit} />
                      <FormInput label="نقطه سفارش (تعداد)" id="edit-reorderPoint" type="number" min="0" value={reorderPoint} onChange={e => setReorderPoint(e.target.value)} disabled={!canEdit} />
                    </div>
                    {/* Column 2: Unit Conversion */}
                    <div className="space-y-4 rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-800/50 h-fit">
                        <p className="font-semibold text-gray-800 dark:text-gray-200">واحد تبدیل</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 -mt-3">برای محاسبه وزن، مشخص کنید چه تعداد از این کالا معادل یک کیلوگرم است.</p>
                        <div className="flex items-center gap-3">
                            <input id="edit-base-count" type="number" min="1" step="1" value={baseCount} onChange={e => setBaseCount(e.target.value)} disabled={!canEdit} placeholder="تعداد" className="w-full px-3 py-2 rounded-lg border text-base form-input transition disabled:opacity-50" />
                            <span className="text-gray-500 dark:text-gray-400">عدد</span>
                            <span className="text-xl font-bold text-gray-400 dark:text-gray-500">=</span>
                            <input id="edit-base-weight" type="number" min="0.001" step="any" value={baseWeight} onChange={e => setBaseWeight(e.target.value)} disabled={!canEdit} placeholder="وزن" className="w-full px-3 py-2 rounded-lg border text-base form-input transition disabled:opacity-50" />
                            <span className="text-gray-500 dark:text-gray-400">ک‌گ</span>
                        </div>
                        <FormInput label="تعداد محاسبه شده در هر کیلوگرم" id="edit-itemsPerKg" type="text" value={(parseFloat(itemsPerKg) || 0).toFixed(4)} disabled className="!bg-gray-200 dark:!bg-gray-800 cursor-not-allowed"/>
                    </div>
                     {/* Reorder Point Optimization Section */}
                    <div className="lg:col-span-2 space-y-3 rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-800/50">
                        <p className="font-semibold text-gray-800 dark:text-gray-200">بهینه‌سازی نقطه سفارش</p>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                             <FormInput label="میانگین مصرف روزانه" id="edit-daily-usage" type="number" min="0" value={dailyUsage} onChange={e=>setDailyUsage(e.target.value)} disabled={!canEdit} placeholder="تعداد"/>
                             <FormInput label="زمان تحویل (روز)" id="edit-lead-time" type="number" min="0" value={leadTime} onChange={e=>setLeadTime(e.target.value)} disabled={!canEdit} placeholder="روز"/>
                             <FormInput label="موجودی اطمینان (روز)" id="edit-safety-stock" type="number" min="0" value={safetyStockDays} onChange={e=>setSafetyStockDays(e.target.value)} disabled={!canEdit} placeholder="روز"/>
                        </div>
                        {optimizedReorderPoint !== null && (
                            <div className="flex items-center justify-between p-2 bg-blue-100 dark:bg-blue-900/50 rounded-md">
                                <span className="text-sm font-medium text-blue-800 dark:text-blue-200">نقطه سفارش محاسبه شده: <span className="font-bold">{optimizedReorderPoint.toLocaleString()}</span></span>
                                <button type="button" onClick={() => setReorderPoint(optimizedReorderPoint.toString())} className="text-xs py-1 px-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition" disabled={!canEdit}>اعمال</button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex justify-end gap-3 p-4 bg-gray-50 dark:bg-gray-900/50 border-t border-gray-200 dark:border-gray-700 rounded-b-lg">
                <button type="button" onClick={onClose} className="py-2 px-5 rounded-lg bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-white transition text-sm font-semibold">انصراف</button>
                <PrimaryButton onClick={handleSave} disabled={!canEdit} className="w-auto px-6">ذخیره تغییرات</PrimaryButton>
            </div>
        </Modal>
    );
};

const HistoryModal = ({ item, transactions, isOpen, onClose }: {item: Part | null, transactions: Transaction[], isOpen: boolean, onClose: () => void}) => {
    const getTodayString = () => new Date().toLocaleDateString('en-CA');

    const [dateRange, setDateRange] = useState({ start: '', end: '' });

    useEffect(() => {
      if (isOpen) {
        const today = getTodayString();
        setDateRange({ start: today, end: today });
      }
    }, [isOpen]);

    const displayedTransactions = useMemo(() => {
        if (!item) return [];
        const { start: startDate, end: endDate } = dateRange;

        return transactions
            .filter(tx => {
                if (tx.partId !== item.id) return false;
                
                const txDate = tx.timestamp.substring(0, 10); // Extracts YYYY-MM-DD from ISO string

                if (startDate && txDate < startDate) return false;
                if (endDate && txDate > endDate) return false;
                
                return true;
            })
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }, [transactions, item, dateRange]);
    
    const toShamsiDisplay = (dateStr: string) => {
        if (!dateStr) return '';
        try {
            return new Date(dateStr).toLocaleDateString('fa-IR');
        } catch (e) {
            return 'تاریخ نامعتبر';
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="xl" position="top">
            <div className="p-6">
                <h3 className="text-xl font-bold mb-4">تاریخچه: {item?.name}</h3>
                <div className="flex flex-wrap items-end gap-4 mb-4">
                    <div>
                        <label htmlFor="start-date-filter" className="flex justify-between items-baseline text-sm font-medium mb-1">
                            <span>از تاریخ</span>
                            <span className="font-normal text-xs text-gray-500 dark:text-gray-400">{toShamsiDisplay(dateRange.start)}</span>
                        </label>
                        <input
                            id="start-date-filter" 
                            type="date" 
                            value={dateRange.start} 
                            onChange={e => setDateRange(prev => ({ ...prev, start: e.target.value }))} 
                            className="block w-full px-3 py-2 rounded-lg border text-base form-input transition max-w-xs"
                        />
                    </div>
                    <div>
                        <label htmlFor="end-date-filter" className="flex justify-between items-baseline text-sm font-medium mb-1">
                            <span>تا تاریخ</span>
                            <span className="font-normal text-xs text-gray-500 dark:text-gray-400">{toShamsiDisplay(dateRange.end)}</span>
                        </label>
                        <input 
                            id="end-date-filter" 
                            type="date" 
                            value={dateRange.end} 
                            onChange={e => setDateRange(prev => ({ ...prev, end: e.target.value }))} 
                            className="block w-full px-3 py-2 rounded-lg border text-base form-input transition max-w-xs"
                        />
                    </div>
                </div>
                <div className="overflow-y-auto max-h-[60vh]">
                    <table className="min-w-full text-sm">
                        <thead className="sticky top-0 border-b border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800">
                            <tr>
                                <th scope="col" className="px-4 py-3 text-center text-sm font-semibold">عملیات</th>
                                <th scope="col" className="px-4 py-3 text-center text-sm font-semibold">مقدار (تعداد)</th>
                                <th scope="col" className="px-4 py-3 text-center text-sm font-semibold">مقدار (وزن)</th>
                                <th scope="col" className="px-4 py-3 text-center text-sm font-semibold">تاریخ و ساعت</th>
                                <th scope="col" className="px-4 py-3 text-center text-sm font-semibold">موجودی لحظه‌ای</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                            {displayedTransactions.length > 0 ? displayedTransactions.map(tx => {
                                const isEntry = tx.operation === 'ورود';
                                return (
                                    <tr key={tx.id}>
                                        <td className={`px-4 py-3 font-semibold text-center ${isEntry ? 'text-green-500' : 'text-red-500'}`}>{tx.operation}</td>
                                        <td className="px-4 py-3 text-center">{tx.quantityChange.toLocaleString()}</td>
                                        <td className="px-4 py-3 text-center">{tx.weightChangeKg.toFixed(2)} کیلوگرم</td>
                                        <td className="px-4 py-3 text-center">{new Date(tx.timestamp).toLocaleString('fa-IR')}</td>
                                        <td className="px-4 py-3 text-center">{tx.snapshotQuantity.toLocaleString()} / {tx.snapshotWeightKg.toFixed(2)} ک‌گ</td>
                                    </tr>
                                )
                            }) : (
                                <tr><td colSpan={5} className="text-center py-10 text-gray-500 dark:text-gray-400">هیچ تراکنشی برای این کالا و فیلتر یافت نشد.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </Modal>
    );
};

const InventoryItem = ({ part, permissions, onEdit, onDelete, onHistory, isNewlyReordered }: { part: Part, permissions: Record<string, boolean>, onEdit: (part: Part) => void, onDelete: (partId: string) => void, onHistory: (part: Part) => void, isNewlyReordered: boolean }) => {
    const isBelowReorderPoint = part.quantity <= part.reorderPoint;
    const reorderDate = part.reorderTriggeredDate ? new Date(part.reorderTriggeredDate) : null;
    const wasTriggeredRecently = reorderDate && (new Date().getTime() - reorderDate.getTime()) < 24 * 60 * 60 * 1000;
    const highlightClass = isNewlyReordered || wasTriggeredRecently ? 'bg-yellow-100 dark:bg-yellow-900/40 animate-pulse-fast' : isBelowReorderPoint ? 'bg-red-100 dark:bg-red-900/30' : '';

    const weightKg = part.itemsPerKg > 0 ? (part.quantity / part.itemsPerKg).toFixed(2) : 'N/A';

    return (
        <tr className={`transition-colors ${highlightClass}`}>
            <td className="px-4 py-3 font-medium">{part.name}</td>
            <td className={`px-4 py-3 text-center font-bold ${isBelowReorderPoint ? 'text-red-500' : ''}`}>{part.quantity.toLocaleString()}</td>
            <td className="px-4 py-3 text-center">{weightKg}</td>
            <td className="px-4 py-3 text-center">{part.reorderPoint.toLocaleString()}</td>
            <td className="px-4 py-3 text-center">
                <div className="flex items-center justify-center gap-1">
                    <IconButton title="تاریخچه" onClick={() => onHistory(part)}>
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.414-1.415L11 9.586V6z" clipRule="evenodd" /></svg>
                    </IconButton>
                    <IconButton title="ویرایش" onClick={() => onEdit(part)} disabled={!permissions[Permission.CAN_EDIT_ITEMS]}>
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" /><path fillRule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" /></svg>
                    </IconButton>
                    <IconButton title="حذف" onClick={() => onDelete(part.id)} disabled={!permissions[Permission.CAN_DELETE_ITEMS]}>
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" /></svg>
                    </IconButton>
                </div>
            </td>
        </tr>
    );
};

const InventoryList = ({ parts, searchTerm, permissions, onEdit, onDelete, onHistory, newlyReorderedPartIds }: { parts: Part[], searchTerm: string, permissions: Record<string, boolean>, onEdit: (part: Part) => void, onDelete: (partId: string) => void, onHistory: (part: Part) => void, newlyReorderedPartIds: Set<string> }) => {
    const filteredParts = useMemo(() => {
        const normalizedSearch = normalizeSearchString(searchTerm);
        if (!normalizedSearch) return parts;
        return parts.filter(p => normalizeSearchString(p.name).includes(normalizedSearch));
    }, [parts, searchTerm]);

    return (
        <Card className="flex-1 overflow-y-auto">
            <h3 className="text-xl font-bold mb-4">لیست کالاها</h3>
            <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                    <thead className="sticky top-0 border-b border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800">
                        <tr>
                            <th scope="col" className="px-4 py-3 text-right font-semibold">نام کالا</th>
                            <th scope="col" className="px-4 py-3 text-center font-semibold">تعداد موجود</th>
                            <th scope="col" className="px-4 py-3 text-center font-semibold">وزن موجود (ک‌گ)</th>
                            <th scope="col" className="px-4 py-3 text-center font-semibold">نقطه سفارش</th>
                            <th scope="col" className="px-4 py-3 text-center font-semibold">عملیات</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                        {filteredParts.length > 0 ? filteredParts.map(part => (
                            <InventoryItem 
                                key={part.id} 
                                part={part}
                                permissions={permissions}
                                onEdit={onEdit}
                                onDelete={onDelete}
                                onHistory={onHistory}
                                isNewlyReordered={newlyReorderedPartIds.has(part.id)}
                            />
                        )) : (
                            <tr><td colSpan={5} className="text-center py-10 text-gray-500 dark:text-gray-400">هیچ کالایی یافت نشد.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </Card>
    );
};

// --- Main App Component ---
const App = () => {
    const [user, setUser] = useLocalStorage<User | null>('user', null);
    const [panelMode, setPanelMode] = useLocalStorage<string>('panelMode', 'main');
    const [parts, setParts] = useState<Part[]>([]);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [workshops, setWorkshops] = useState<any[]>([]);
    const [wages, setWages] = useState<any>({});
    const [users, setUsers] = useState<User[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [toast, setToast] = useState<{message: string, type: 'info' | 'success' | 'error'} | null>(null);
    const [editItem, setEditItem] = useState<Part | null>(null);
    const [historyItem, setHistoryItem] = useState<Part | null>(null);
    const [showAddPart, setShowAddPart] = useState(false);
    const [newlyReorderedPartIds, setNewlyReorderedPartIds] = useState<Set<string>>(new Set());
    const [lastServerUpdate, setLastServerUpdate] = useState(0);

    const permissions = useMemo(() => {
        if (!user) return DEFAULT_VIEWER_PERMISSIONS;
        if (user.username === 'trade_master') return DEFAULT_ADMIN_PERMISSIONS;
        return { ...DEFAULT_VIEWER_PERMISSIONS, ...user.permissions };
    }, [user]);

    const fetchData = useCallback(async (currentUser: User, currentPanelMode: string) => {
        if (!currentUser) return;
        setIsLoading(true);
        try {
            const data = await api.getBootstrapData(currentUser, currentPanelMode);
            setParts(data.parts.sort((a: Part, b: Part) => a.name.localeCompare(b.name, 'fa')));
            setTransactions(data.transactions);
            setUsers(data.users);
            setWorkshops(data.workshops);
            setWages(data.wages);
        } catch (error: any) {
            setToast({ message: `خطا در بارگیری داده‌ها: ${error.message}`, type: 'error' });
            if (error.message.includes('401')) handleLogout(); // Unauthorized
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (user) {
            fetchData(user, panelMode);
            api.updateLastSeen(user.id);

            const intervalId = setInterval(async () => {
                try {
                    const { lastUpdate } = await api.getLastUpdate();
                    if (lastUpdate > lastServerUpdate && lastServerUpdate !== 0) {
                        console.log('Server data has been updated. Refetching...');
                        setToast({ message: 'داده‌ها بروزرسانی شد.', type: 'info' });
                        await fetchData(user, panelMode);
                    }
                    setLastServerUpdate(lastUpdate);
                } catch (error) {
                    console.error("Polling error:", error);
                }
            }, 10000); // Poll every 10 seconds

            const handleMessage = (event: MessageEvent) => {
                if (event.data && event.data.type === 'wageUpdated') {
                    console.log('Wage data updated from iframe. Refetching...');
                    setToast({ message: 'دستمزد بروزرسانی شد.', type: 'info' });
                    fetchData(user, panelMode);
                }
            };
            window.addEventListener('message', handleMessage);


            return () => {
                clearInterval(intervalId);
                window.removeEventListener('message', handleMessage);
            };
        }
    }, [user, panelMode, fetchData, lastServerUpdate]);

    const handleLogin = (loggedInUser: User) => {
        setUser(loggedInUser);
        setPanelMode(loggedInUser.username === 'trade_master' ? 'main' : 'personal');
    };

    const handleLogout = () => {
        setUser(null);
    };

    const handleAddPart = async (partData: Partial<Part>) => {
        try {
            const newPartId = crypto.randomUUID();
            const quantity = partData.quantity || 0;
            const newPart: Part = {
                id: newPartId,
                name: partData.name!,
                quantity: quantity,
                itemsPerKg: partData.itemsPerKg!,
                reorderPoint: partData.reorderPoint!,
                baseCount: partData.baseCount,
                baseWeight: partData.baseWeight,
                dailyUsage: partData.dailyUsage,
                leadTime: partData.leadTime,
                safetyStockDays: partData.safetyStockDays,
                reorderTriggeredDate: null,
            };
            
            await api.addPart(newPart, user!, panelMode);
            
            if (quantity > 0) {
                const weight = newPart.itemsPerKg > 0 ? quantity / newPart.itemsPerKg : 0;
                const tx: Transaction = {
                    id: crypto.randomUUID(),
                    partId: newPart.id,
                    partName: newPart.name,
                    operation: 'ورود',
                    quantityChange: quantity,
                    weightChangeKg: weight,
                    timestamp: new Date().toISOString(),
                    snapshotQuantity: quantity,
                    snapshotWeightKg: weight,
                };
                await api.addTransaction({ transactionRecord: tx, partId: newPart.id, transactionQuantity: 0, costDestinations: [] }, user!, panelMode);
            }
            
            setToast({ message: 'کالا با موفقیت افزوده شد.', type: 'success' });
            setShowAddPart(false);
            await fetchData(user!, panelMode);
        } catch (error: any) {
            setToast({ message: `خطا در افزودن کالا: ${error.message}`, type: 'error' });
        }
    };
    
    const handleUpdatePart = async (updatedPart: Part) => {
        try {
            await api.updatePart(updatedPart.id, updatedPart, user!, panelMode);
            setToast({ message: 'کالا با موفقیت ویرایش شد.', type: 'success' });
            setParts(prev => prev.map(p => p.id === updatedPart.id ? updatedPart : p).sort((a,b) => a.name.localeCompare(b.name, 'fa')));
        } catch (error: any) {
            setToast({ message: `خطا در ویرایش کالا: ${error.message}`, type: 'error' });
        }
    };

    const handleDeletePart = async (partId: string) => {
        if (window.confirm('آیا از حذف این کالا و تمام تاریخچه آن مطمئن هستید؟')) {
            try {
                await api.deletePart(partId, user!, panelMode);
                setToast({ message: 'کالا با موفقیت حذف شد.', type: 'success' });
                await fetchData(user!, panelMode);
            } catch (error: any) {
                setToast({ message: `خطا در حذف کالا: ${error.message}`, type: 'error' });
            }
        }
    };

    const handleTransaction = async (partId: string, transactionQuantity: number, transactionRecord: Transaction, costDestinations: any[]) => {
        const part = parts.find(p => p.id === partId);
        if (!part) return;
        
        const newQuantity = part.quantity + transactionQuantity;
        let reorderTriggeredDate = part.reorderTriggeredDate;
        
        if (newQuantity <= part.reorderPoint && (part.quantity > part.reorderPoint || !part.reorderTriggeredDate)) {
             reorderTriggeredDate = new Date().toISOString();
             setNewlyReorderedPartIds(prev => new Set(prev).add(part.id));
             setTimeout(() => {
                setNewlyReorderedPartIds(prev => {
                    const newSet = new Set(prev);
                    newSet.delete(part.id);
                    return newSet;
                });
             }, 5000);
        } else if (newQuantity > part.reorderPoint) {
            reorderTriggeredDate = null;
        }

        try {
            await api.addTransaction({ transactionRecord, partId, transactionQuantity, reorderTriggeredDate, costDestinations }, user!, panelMode);
            setToast({ message: 'تراکنش با موفقیت ثبت شد.', type: 'success' });
            await fetchData(user!, panelMode); // Refetch to get latest state
        } catch (error: any) {
            setToast({ message: `خطا در ثبت تراکنش: ${error.message}`, type: 'error' });
        }
    };

    if (!user) {
        return <LoginPage onLogin={handleLogin} setToast={setToast} />;
    }
    
    return (
        <div className="flex flex-col h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-sans-fa">
             {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
            {/* Header */}
            <header className="bg-white dark:bg-gray-800 shadow-md p-4 flex justify-between items-center z-10">
                <h1 className="text-2xl font-bold">انبار اصلی</h1>
                <div className="flex items-center gap-4">
                    <span className="text-sm font-semibold">کاربر: {user.displayName || user.username}</span>
                    <PrimaryButton onClick={handleLogout}>خروج</PrimaryButton>
                </div>
            </header>

            {/* Main Content */}
            <main className="flex-1 p-4 lg:p-6 overflow-hidden flex flex-col lg:flex-row gap-6">
                {/* Left Column: Forms */}
                <div className="w-full lg:w-1/3 xl:w-1/4 flex flex-col gap-6">
                    <TransactionForm 
                        parts={parts} 
                        onTransaction={handleTransaction} 
                        permissions={permissions}
                        searchTerm={searchTerm}
                        setSearchTerm={setSearchTerm}
                        workshops={workshops}
                        wages={wages}
                    />
                    <Card>
                        <PrimaryButton onClick={() => setShowAddPart(prev => !prev)} className="w-full mb-4">
                            {showAddPart ? 'پنهان کردن فرم افزودن کالا' : 'افزودن کالای جدید'}
                        </PrimaryButton>
                        {showAddPart && <AddPartForm onAddPart={handleAddPart} permissions={permissions} />}
                    </Card>
                </div>

                {/* Right Column: Inventory List */}
                <InventoryList 
                    parts={parts}
                    searchTerm={searchTerm}
                    permissions={permissions}
                    onEdit={(part) => setEditItem(part)}
                    onDelete={handleDeletePart}
                    onHistory={(part) => setHistoryItem(part)}
                    newlyReorderedPartIds={newlyReorderedPartIds}
                />
            </main>
            
            {/* Modals */}
            {editItem && (
                <EditItemModal
                    item={editItem}
                    isOpen={!!editItem}
                    onClose={() => setEditItem(null)}
                    onSave={handleUpdatePart}
                    permissions={permissions}
                />
            )}
            {historyItem && (
                <HistoryModal
                    item={historyItem}
                    transactions={transactions}
                    isOpen={!!historyItem}
                    onClose={() => setHistoryItem(null)}
                />
            )}
        </div>
    );
};

// --- Render App ---
const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
    <StrictMode>
        <App />
    </StrictMode>
);
