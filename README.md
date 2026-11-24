# WedPlan – Backend API

WedPlan Backend is a RESTful API built with Node.js, Express.js, and MongoDB. It handles authentication verification, user management, wedding service management, booking operations, subscriptions, and payment processing.

## 🌐 Project Links

- **Live Website:** https://wed-plan-client-1.vercel.app
- **Backend API:** https://wedplan-server-1.vercel.app
- **GitHub Repository:** https://github.com/jenodinerifat59/wedplan-server-1

## ✨ Key Features

- **RESTful API:** Organized API endpoints for frontend communication.
- **JWT Authentication:** Verifies authenticated users using JSON Web Tokens.
- **Role-Based Authorization:** Supports Admin, Vendor, and Customer permissions.
- **User Management:** Handles user-related operations and account information.
- **Service Management:** Create, retrieve, update, and delete wedding services.
- **Booking Management:** Handles customer booking requests and vendor booking operations.
- **Admin Management:** Supports administrative operations and platform management.
- **MongoDB Integration:** Stores users, services, bookings, and related application data.
- **Subscription Management:** Handles vendor subscription plans and subscription status.
- **Stripe Integration:** Supports payment processing and webhook handling.
- **Notifications:** Stores notifications for relevant application activities.
- **Secure API Requests:** Uses authenticated requests and role-based access checks.

## 🛠️ Technologies Used

- Node.js
- Express.js
- MongoDB
- JavaScript
- Better Auth
- JSON Web Token (JWT)
- Stripe
- REST API
- dotenv
- CORS

## 📦 Dependencies

Install all required packages:

```bash
npm install
```

## ⚙️ Environment Variables

Create a `.env` file in the backend root directory:

```env
PORT=5000

MONGODB_URI=your_mongodb_connection_string
DB_NAME=wedplan

BETTER_AUTH_SECRET=your_better_auth_secret
BETTER_AUTH_URL=your_better_auth_url

STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret

CLIENT_URL=http://localhost:3000
```

Add any additional environment variables required by your actual backend source code.

**Important:** Never commit `.env` files or expose secret keys in a public repository.

## 🚀 Run Locally

1. Clone the repository:

```bash
git clone YOUR_BACKEND_REPOSITORY_URL
```

2. Navigate to the backend directory:

```bash
cd wedplan-server
```

3. Install dependencies:

```bash
npm install
```

4. Configure the `.env` file with your credentials.

5. Start the development server:

```bash
npm run dev
```

If your project does not have a `dev` script, use the start command configured in `package.json`.

The backend will run at:

```text
http://localhost:5000
```

## 🔐 Authentication & Authorization

WedPlan uses Better Auth for user authentication and JWT verification for protected backend API requests.

Supported user roles:

| Role | Permissions |
|---|---|
| Admin | Administrative operations |
| Vendor | Manage services and bookings |
| Customer | Browse services and create bookings |

Protected API requests should include:

```http
Authorization: Bearer YOUR_JWT_TOKEN
```

The backend verifies the token and checks the user's permissions before allowing protected operations.

## 📡 Main API Modules

| Module | Description |
|---|---|
| Authentication | User authentication and JWT verification |
| Users | User information and account management |
| Services | Wedding service management |
| Bookings | Booking creation and management |
| Vendor | Vendor dashboard operations |
| Admin | Administrative operations |
| Subscriptions | Vendor subscription management |
| Payments | Stripe payment and webhook handling |
| Notifications | Application notifications |

## 🗄️ Database

WedPlan uses MongoDB to store application data.

Main collections include:

- `users`
- `services`
- `bookings`
- `notifications`

Additional collections may be used for authentication, subscriptions, and payment-related records.

## 📁 Project Structure

```text
wedplan-server/
├── index.js
├── routes/
├── middleware/
├── config/
├── utils/
├── .env
├── package.json
└── README.md
```

*Adjust the folder structure above to match your actual backend project.*

## 👨‍💻 Developer

**MD. Jenodine Islam Rifat**

Frontend Developer | React.js | Next.js | TypeScript

